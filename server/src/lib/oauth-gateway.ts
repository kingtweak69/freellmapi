import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The OAuth gateway is a loopback-only companion process. It stamps requests
 * with a random per-process proof so the embedded server can distinguish it
 * from a browser or LAN client that simply invents the same header names.
 */
export function hasOAuthGatewayProof(headers: IncomingHttpHeaders): boolean {
  const expected = process.env.FREEAPI_OAUTH_GATEWAY_TOKEN;
  const supplied = headers['x-freeapi-oauth-reauth'];
  if (!expected || typeof supplied !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function oauthGatewayUser(headers: IncomingHttpHeaders): string | null {
  const user = headers['x-freeapi-oauth-user'];
  return hasOAuthGatewayProof(headers) && typeof user === 'string' && user.trim()
    ? user.trim()
    : null;
}
