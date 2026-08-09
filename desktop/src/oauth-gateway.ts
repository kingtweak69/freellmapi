import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

export interface GitHubOAuthConfig {
  /** Public HTTPS origin served by Funnel, without a trailing slash. */
  publicBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** GitHub logins allowed to use the public dashboard. Never leave empty. */
  allowedGitHubUsers: string[];
  /** Loopback-only listener Funnel should proxy to. Defaults to 31416. */
  port?: number;
}

export interface OAuthGatewayOptions {
  config: GitHubOAuthConfig;
  backendPort: number;
  /** Desktop-only dashboard session. It never leaves this machine except via the local proxy hop. */
  dashboardSessionToken: string;
  /** Random per-process proof trusted by the embedded server for OAuth re-auth. */
  reauthToken: string;
}

export interface OAuthGatewayHandle {
  server: http.Server;
  port: number;
}

interface PendingLogin {
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface OAuthSession {
  login: string;
  expiresAt: number;
}

const SESSION_COOKIE = 'freeapi_github_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function random(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  return raw.split(';').reduce<Record<string, string>>((result, part) => {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
    return result;
  }, {});
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/oauth/')) return '/';
  return value;
}

function isApiPath(pathname: string): boolean {
  return pathname === '/v1' || pathname.startsWith('/v1/') || pathname.startsWith('/v1beta/') || pathname.startsWith('/api/v1/');
}

function isDashboardApi(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function sendHtml(res: ServerResponse, status: number, title: string, message: string): void {
  const escapedTitle = title.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const escapedMessage = message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font:15px system-ui}main{max-width:420px;padding:32px;border:1px solid #27272a;border-radius:20px;background:#18181b}h1{font-size:18px;margin:0 0 12px}p{color:#a1a1aa;line-height:1.5;margin:0}</style><main><h1>${escapedTitle}</h1><p>${escapedMessage}</p></main>`);
}

function copyProxyHeaders(headers: IncomingMessage['headers']): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = {};
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !hopByHop.has(name.toLowerCase())) output[name] = value;
  }
  return output;
}

/**
 * Loopback-only OAuth edge for a public Funnel. Browser dashboard traffic must
 * have a GitHub OAuth session; API clients keep using FreeLLMAPI's existing
 * bearer API key, because interactive OAuth cannot authenticate an SDK call.
 */
export function startOAuthGateway(options: OAuthGatewayOptions): Promise<OAuthGatewayHandle> {
  const origin = new URL(options.config.publicBaseUrl);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('OAuth publicBaseUrl must be an HTTPS origin without a path, query, or hash');
  }
  const allowed = new Set(options.config.allowedGitHubUsers.map(user => user.trim().toLowerCase()).filter(Boolean));
  if (!options.config.clientId || !options.config.clientSecret || allowed.size === 0) {
    throw new Error('OAuth requires GitHub clientId, clientSecret, and at least one allowedGitHubUsers entry');
  }

  const pending = new Map<string, PendingLogin>();
  const signingKey = crypto.randomBytes(32);
  const callbackUrl = new URL('/oauth/github/callback', origin).toString();

  const sign = (payload: OAuthSession): string => {
    const body = base64url(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', signingKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  };
  const readSession = (req: IncomingMessage): OAuthSession | null => {
    const value = parseCookies(req)[SESSION_COOKIE];
    if (!value) return null;
    const [body, mac] = value.split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', signingKey).update(body).digest();
    const received = Buffer.from(mac, 'base64url');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthSession;
      if (!parsed.login || parsed.expiresAt <= Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const clearCookie = (res: ServerResponse) => {
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  };
  const proxy = (req: IncomingMessage, res: ServerResponse, session: OAuthSession | null) => {
    const requestUrl = new URL(req.url ?? '/', origin);
    const headers = copyProxyHeaders(req.headers);
    // The embedded server only accepts loopback origins. The browser is
    // same-origin with this gateway, so forwarding Funnel's public Origin
    // would make its otherwise-safe CORS check reject dashboard API calls.
    delete headers.origin;
    headers.host = `127.0.0.1:${options.backendPort}`;
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = origin.host;
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
    if (session && isDashboardApi(requestUrl.pathname)) {
      // The user has passed GitHub OAuth at this edge. The embedded app still
      // needs its internal dashboard session, which must never be sent to a
      // browser or persisted as a public cookie.
      headers.authorization = `Bearer ${options.dashboardSessionToken}`;
      headers['x-dashboard-token'] = options.dashboardSessionToken;
      headers['x-freeapi-oauth-user'] = session.login;
      headers['x-freeapi-oauth-reauth'] = options.reauthToken;
    }
    const outbound = http.request({ hostname: '127.0.0.1', port: options.backendPort, method: req.method, path: `${requestUrl.pathname}${requestUrl.search}`, headers }, upstream => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    });
    outbound.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'FreeLLMAPI is not available', type: 'service_unavailable' } }));
    });
    req.pipe(outbound);
  };

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', origin);
    if (requestUrl.pathname === '/oauth/github/login') {
      const state = random();
      const verifier = random();
      pending.set(state, { verifier, returnTo: safeReturnTo(requestUrl.searchParams.get('returnTo')), expiresAt: Date.now() + STATE_TTL_MS });
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.searchParams.set('client_id', options.config.clientId);
      authorize.searchParams.set('redirect_uri', callbackUrl);
      authorize.searchParams.set('scope', 'read:user user:email');
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('code_challenge', sha256(verifier));
      authorize.searchParams.set('code_challenge_method', 'S256');
      res.writeHead(302, { location: authorize.toString(), 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/oauth/github/callback') {
      const state = requestUrl.searchParams.get('state') ?? '';
      const code = requestUrl.searchParams.get('code') ?? '';
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || entry.expiresAt < Date.now() || !code) {
        sendHtml(res, 400, 'Sign-in expired', 'Start the GitHub sign-in again from FreeLLMAPI.');
        return;
      }
      try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: options.config.clientId, client_secret: options.config.clientSecret, code, redirect_uri: callbackUrl, code_verifier: entry.verifier }),
        });
        const tokenBody = await tokenResponse.json() as { access_token?: string };
        if (!tokenResponse.ok || !tokenBody.access_token) throw new Error('GitHub did not issue an access token');
        const userResponse = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'FreeLLMAPI-Desktop' } });
        const user = await userResponse.json() as { login?: string };
        const login = user.login?.trim().toLowerCase();
        if (!userResponse.ok || !login || !allowed.has(login)) {
          sendHtml(res, 403, 'Access denied', 'This GitHub account is not allowed to access this FreeLLMAPI instance.');
          return;
        }
        const cookie = encodeURIComponent(sign({ login, expiresAt: Date.now() + SESSION_TTL_MS }));
        res.writeHead(302, { location: entry.returnTo, 'set-cookie': `${SESSION_COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`, 'cache-control': 'no-store' });
        res.end();
      } catch (error) {
        console.warn('[oauth] GitHub callback failed:', error);
        sendHtml(res, 502, 'Sign-in failed', 'GitHub could not complete the sign-in. Please try again.');
      }
      return;
    }
    if (requestUrl.pathname === '/oauth/logout') {
      clearCookie(res);
      res.writeHead(302, { location: '/oauth/github/login', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/oauth/status') {
      const session = readSession(req);
      res.writeHead(session ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(session ? { authenticated: true, login: session.login } : { authenticated: false }));
      return;
    }

    const session = readSession(req);
    if (isApiPath(requestUrl.pathname) && !session && !req.headers.authorization) {
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message: 'GitHub OAuth session or FreeLLMAPI API key required', type: 'authentication_error' } }));
      return;
    }
    if (!session && !isApiPath(requestUrl.pathname)) {
      const returnTo = encodeURIComponent(`${requestUrl.pathname}${requestUrl.search}`);
      res.writeHead(302, { location: `/oauth/github/login?returnTo=${returnTo}`, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    proxy(req, res, session);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.config.port ?? 31416, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('OAuth gateway did not report a TCP port'));
      resolve({ server, port: address.port });
    });
  });
}
