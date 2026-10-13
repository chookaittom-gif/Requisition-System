export type FailCode = 'AUTH' | 'FORBIDDEN' | 'RATE_LIMIT' | 'VALIDATION';

export type HeaderMap = Record<string, string | string[]>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function fail(message: string, code?: FailCode): { ok: false; message: string; code?: string } {
  return code ? { ok: false, message, code } : { ok: false, message };
}

export interface WithHeaders {
  __rpc: true;
  body: unknown;
  headers: HeaderMap;
}

/** Handler return wrapper: JSON body plus extra response headers (e.g. Set-Cookie). */
export function withHeaders(body: unknown, headers: HeaderMap): WithHeaders {
  return { __rpc: true, body, headers };
}

export function isWithHeaders(v: unknown): v is WithHeaders {
  return typeof v === 'object' && v !== null && (v as { __rpc?: unknown }).__rpc === true;
}
