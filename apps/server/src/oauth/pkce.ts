import crypto from 'node:crypto';

/**
 * RFC 7636 PKCE, S256 only. Shared by the MCP authorization server
 * (routes.ts, token.ts) and the desktop sign-in handoff
 * (../desktop-handoff.ts). Imports nothing from the app: auth.ts reaches
 * this module through desktop-handoff.ts, and token.ts imports auth.ts.
 */

/** base64url(SHA-256(verifier)): always 43 characters, no padding. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function pkceMatches(verifier: string, challenge: string): boolean {
  const a = crypto.createHash('sha256').update(verifier).digest();
  let b: Buffer;
  try { b = Buffer.from(challenge, 'base64url'); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
