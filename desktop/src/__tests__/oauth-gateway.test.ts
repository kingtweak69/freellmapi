import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startOAuthGateway } from '../oauth-gateway.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function options() {
  return {
    config: {
      publicBaseUrl: 'https://tweakomputer.tail32d35c.ts.net:10000',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      allowedGitHubUsers: ['kingtweak69'],
      port: 0,
    },
    backendPort: 31415,
    dashboardSessionToken: 'desktop-session',
    reauthToken: 'gateway-proof',
  };
}

describe('GitHub OAuth gateway', () => {
  it('refuses a non-HTTPS public callback origin', async () => {
    const input = options();
    input.config.publicBaseUrl = 'http://example.test';
    expect(() => startOAuthGateway(input)).toThrow(/HTTPS origin/);
  });

  it('redirects anonymous dashboard traffic into GitHub OAuth', async () => {
    const gateway = await startOAuthGateway(options());
    servers.push(gateway.server);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/models/chat?sort=fast`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/oauth/github/login?returnTo=%2Fmodels%2Fchat%3Fsort%3Dfast');
  });

  it('does not redirect anonymous SDK requests to an HTML login page', async () => {
    const gateway = await startOAuthGateway(options());
    servers.push(gateway.server);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/models`, { redirect: 'manual' });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { type: 'authentication_error' } });
  });

  it('does not forward Funnel browser origins to the loopback server', async () => {
    const backend = createServer((request, response) => {
      expect(request.headers.origin).toBeUndefined();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
    servers.push(backend);
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('test backend did not report a TCP port');

    const gateway = await startOAuthGateway({ ...options(), backendPort: address.port });
    servers.push(gateway.server);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/models`, {
      headers: { authorization: 'Bearer an-api-key', origin: 'https://tweakomputer.tail32d35c.ts.net:10000' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
