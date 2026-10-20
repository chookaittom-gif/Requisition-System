const ITERATIONS = 100_000;
const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Constant-time string comparison (length is not secret; content is). */
function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function pbkdf2(pw: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pw, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(
  stored: string,
  pw: string,
  salt: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const s = String(stored ?? '').trim();
  if (s.startsWith('pbkdf2$')) {
    const [, iterStr, saltB64, hashB64] = s.split('$');
    const iterations = Number(iterStr);
    if (!Number.isInteger(iterations) || iterations < 1 || !saltB64 || !hashB64) {
      return { ok: false, needsRehash: false };
    }
    try {
      const derived = await pbkdf2(pw, fromB64(saltB64), iterations);
      return { ok: timingSafeEqual(toB64(derived), hashB64), needsRehash: false };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }
  if (s.startsWith('sha256$')) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${salt}|${pw}`));
    return { ok: timingSafeEqual(s, 'sha256$' + toHex(digest)), needsRehash: true };
  }
  return { ok: timingSafeEqual(s, String(pw)), needsRehash: true };
}
