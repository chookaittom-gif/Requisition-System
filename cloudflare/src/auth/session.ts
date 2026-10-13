import type { Env } from '../env';
import type { Ctx } from '../rpc';
import { nowBkk } from '../lib/time';
import { toB64 } from './password';

export interface Session {
  id: string;
  role: 'admin' | 'officer' | 'staff';
  username: string;
  tokenHash: string;
}

export const COOKIE_NAME = 'ims_session';
export const SESSION_TTL_S = 28_800;
const COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Lax; Path=/';

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const b64url = (bytes: Uint8Array): string => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readToken(req: Request): string | null {
  const header = req.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export async function createSession(
  env: Env,
  user: { id: string; role: string },
): Promise<{ token: string; cookie: string }> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      await sha256Hex(token),
      user.id,
      user.role,
      nowBkk(now),
      nowBkk(new Date(now.getTime() + SESSION_TTL_S * 1000)),
    )
    .run();
  return { token, cookie: `${COOKIE_NAME}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_S}` };
}

export async function getSession(ctx: Ctx): Promise<Session | null> {
  const token = readToken(ctx.req);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await ctx.env.DB.prepare(
    'SELECT s.user_id AS id, u.role AS role, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  )
    .bind(tokenHash, nowBkk())
    .first<{ id: string; role: Session['role']; username: string }>();
  return row ? { id: row.id, role: row.role, username: row.username, tokenHash } : null;
}

/** Deletes the caller's session row; returns the cookie header value that clears it. */
export async function destroySession(ctx: Ctx): Promise<string> {
  if (ctx.session) {
    await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(ctx.session.tokenHash).run();
  }
  return `${COOKIE_NAME}=; ${COOKIE_ATTRS}; Max-Age=0`;
}
