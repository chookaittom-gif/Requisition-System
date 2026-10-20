import type { Env } from '../env';

export const FOLDER_NAMES = ['Logo', 'Banner', 'MaterialImages', 'MaterialFiles', 'RequestAttachments'] as const;
export type FolderName = (typeof FOLDER_NAMES)[number];

export const MAX_UPLOAD_BYTES = 26_214_400;
export const CHUNK_SIZE = 5_242_880;
export const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

/** Refresh-token grant; cached in module scope until 60 s before expiry. Never logs secrets. */
export async function getAccessToken(env: Env): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  inflight ??= (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: env.GOOGLE_REFRESH_TOKEN,
          grant_type: 'refresh_token',
        }),
      });
      const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
      if (!res.ok || !data?.access_token) throw new Error('เชื่อมต่อ Google Drive ไม่สำเร็จ');
      cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
      return data.access_token;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Authenticated Google API call. */
export async function driveFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await getAccessToken(env)}`);
  return fetch(url, { ...init, headers });
}

/** Finds the named subfolder under the root folder, creating it when missing. */
export async function ensureSubfolder(env: Env, name: FolderName): Promise<string> {
  const q = `'${env.DRIVE_ROOT_FOLDER_ID}' in parents and name = '${name}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const list = await driveFetch(env, `${DRIVE_API}/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`);
  if (!list.ok) throw new Error('เชื่อมต่อ Google Drive ไม่สำเร็จ');
  const found = ((await list.json()) as { files?: { id: string }[] }).files?.[0];
  if (found) return found.id;
  const created = await driveFetch(env, `${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [env.DRIVE_ROOT_FOLDER_ID] }),
  });
  if (!created.ok) throw new Error('เชื่อมต่อ Google Drive ไม่สำเร็จ');
  return ((await created.json()) as { id: string }).id;
}
