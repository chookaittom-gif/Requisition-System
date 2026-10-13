import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SALT = 'SALT';
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const legacyHash = async (pw: string) =>
  'sha256$' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${SALT}|${pw}`)));

const post = (fn: string, args: unknown[], cookie?: string, headers: Record<string, string> = {}) =>
  SELF.fetch(
    new Request(`https://example.com/api/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: JSON.stringify({ args }),
    }),
  );
const rows = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<any>()).results;

const login = async (username: string, role: string) => {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind('U-' + username, username, await legacyHash('1234'), username, role, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    .run();
  const res = await post('apiLogin', [{ username, password: '1234' }]);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
};

type Call = { method: string; url: string; headers: Headers; body: unknown };
let calls: Call[];
let fileMeta: Record<string, unknown>;
let chunkStatus: number;

function mockGoogle() {
  calls = [];
  fileMeta = { id: 'DRV1', name: 'a.png', mimeType: 'image/png', size: '1000', parents: ['SUB1'] };
  chunkStatus = 308;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const req = new Request(input, init);
    const url = req.url;
    const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.clone().text();
    calls.push({ method: req.method, url, headers: req.headers, body });
    const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return j({ access_token: 'tok', expires_in: 3600 });
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1')) {
      if (chunkStatus === 308) return new Response(null, { status: 308, headers: { Range: 'bytes=0-5242879' } });
      return j({ id: 'DRV1' }, chunkStatus);
    }
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))
      return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1' } });
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) return j({ files: [{ id: 'SUB1' }] });
    if (/drive\/v3\/files\/DRV1\/permissions/.test(url)) return j({ id: 'perm' });
    if (/drive\/v3\/files\/DRV1/.test(url)) return req.method === 'DELETE' ? new Response(null, { status: 204 }) : j(fileMeta);
    return j({}, 404);
  });
}

let off: string;
let admin: string;
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions'), env.DB.prepare('DELETE FROM drive_files')]);
  off = await login('upoff', 'officer');
  admin = await login('upadm', 'admin');
  mockGoogle();
});
afterEach(() => vi.restoreAllMocks());

const start = (over: Record<string, unknown> = {}, cookie?: string, h: Record<string, string> = {}) =>
  post('apiStartUpload', [{ purpose: 'material_image', fileName: 'a.png', mimeType: 'image/png', size: 1000, ...over }], cookie, h).then(
    (r) => r.json() as Promise<any>,
  );

describe('uploads', () => {
  it('start rejects size over 25 MB', async () => {
    const r = await start({ size: 26214401 }, off);
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(await rows('SELECT * FROM drive_files')).toHaveLength(0);
  });

  it('start rejects disallowed MIME', async () => {
    expect(await start({ mimeType: 'application/zip' }, off)).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('start rejects zero/invalid size and unknown purpose', async () => {
    expect(await start({ size: 0 }, off)).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(await start({ purpose: 'evil' }, off)).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('start returns Google session URL, chunkSize 5242880, passes Origin, stores pending row', async () => {
    const r = await start({}, off, { Origin: 'https://app.example.org' });
    expect(r).toMatchObject({ ok: true, uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1', chunkSize: 5242880 });
    expect(r.uploadId).toMatch(/^F-[0-9A-F]{8}$/);
    const init = calls.find((c) => c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))!;
    expect(init.url).toContain('uploadType=resumable');
    expect(init.headers.get('Origin')).toBe('https://app.example.org');
    expect(init.headers.get('X-Upload-Content-Type')).toBe('image/png');
    expect(init.headers.get('X-Upload-Content-Length')).toBe('1000');
    expect(init.headers.get('Authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toMatchObject({ name: 'a.png', parents: ['SUB1'] });
    const [row] = await rows('SELECT * FROM drive_files WHERE id = ?', r.uploadId);
    expect(row).toMatchObject({
      drive_file_id: 'pending:' + r.uploadId,
      entity: 'material_image',
      folder: 'MaterialImages',
      size_bytes: 1000,
      created_by: 'upoff',
      url: '',
      upload_url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1',
    });
  });

  it('start rejects a Location outside www.googleapis.com', async () => {
    const orig = globalThis.fetch as any;
    vi.mocked(globalThis.fetch).mockImplementation(async (input: any, init?: any) => {
      const u = new Request(input, init).url;
      if (u.startsWith('https://www.googleapis.com/upload/'))
        return new Response('', { status: 200, headers: { Location: 'https://evil.example/s' } });
      return orig(input, init);
    });
    expect(await start({}, off)).toMatchObject({ ok: false });
    expect(await rows('SELECT * FROM drive_files')).toHaveLength(0);
  });

  it('start falls back to request origin when no Origin header', async () => {
    await start({}, off);
    const init = calls.find((c) => c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))!;
    expect(init.headers.get('Origin')).toBe('https://example.com');
  });

  it('guest may start only request_attachment; others AUTH', async () => {
    const ok = await start({ purpose: 'request_attachment', fileName: 'a.pdf', mimeType: 'application/pdf' });
    expect(ok.ok).toBe(true);
    expect((await rows('SELECT created_by FROM drive_files WHERE id = ?', ok.uploadId))[0].created_by).toBe('guest');
    expect(await start({ purpose: 'material_image' })).toMatchObject({ ok: false, code: 'AUTH' });
    expect(await start({ purpose: 'logo' })).toMatchObject({ ok: false, code: 'AUTH' });
  });

  it('role checks: officer cannot logo; admin can', async () => {
    expect(await start({ purpose: 'logo' }, off)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect((await start({ purpose: 'logo' }, admin)).ok).toBe(true);
    expect((await start({ purpose: 'banner' }, admin)).ok).toBe(true);
  });

  beforeEach(() => {
    chunkStatus = 200;
  });

  const finish = (uploadId: string, driveFileId: string | undefined = 'DRV1', cookie?: string) =>
    post('apiFinishUpload', [driveFileId ? { uploadId, driveFileId } : { uploadId }], cookie).then((r) => r.json() as Promise<any>);

  it('finish sets anyone-reader permission and returns lh3 URL for images', async () => {
    const s = await start({}, off);
    const r = await finish(s.uploadId, 'DRV1', off);
    expect(r).toEqual({ ok: true, url: 'https://lh3.googleusercontent.com/d/DRV1', driveFileId: 'DRV1' });
    const perm = calls.find((c) => c.method === 'POST' && /files\/DRV1\/permissions/.test(c.url))!;
    expect(JSON.parse(String(perm.body))).toEqual({ role: 'reader', type: 'anyone' });
    const [row] = await rows('SELECT * FROM drive_files WHERE id = ?', s.uploadId);
    expect(row).toMatchObject({ drive_file_id: 'DRV1', url: r.url, upload_url: '' });
  });

  it('finish returns drive view URL for non-images', async () => {
    const s = await start({ purpose: 'material_file', fileName: 'a.pdf', mimeType: 'application/pdf' }, off);
    fileMeta = { id: 'DRV1', name: 'a.pdf', mimeType: 'application/pdf', size: '1000', parents: ['SUB1'] };
    expect((await finish(s.uploadId, 'DRV1', off)).url).toBe('https://drive.google.com/file/d/DRV1/view');
  });

  it('finish deletes a file whose real size exceeds the limit', async () => {
    const s = await start({}, off);
    fileMeta = { ...fileMeta, size: '26214401' };
    const r = await finish(s.uploadId, 'DRV1', off);
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(calls.some((c) => c.method === 'DELETE' && /files\/DRV1/.test(c.url))).toBe(true);
    expect(calls.some((c) => /permissions/.test(c.url))).toBe(false);
  });

  it('finish deletes on wrong parent, wrong size, wrong mime', async () => {
    for (const bad of [{ parents: ['OTHER'] }, { size: '999' }, { mimeType: 'application/zip' }]) {
      calls.length = 0;
      const s = await start({}, off);
      fileMeta = { id: 'DRV1', name: 'a.png', mimeType: 'image/png', size: '1000', parents: ['SUB1'], ...bad };
      expect(await finish(s.uploadId, 'DRV1', off)).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    }
  });

  it('finish: unknown uploadId, other user, and double finish are rejected', async () => {
    expect(await finish('F-NOPE0000', 'DRV1', off)).toMatchObject({ ok: false });
    const s = await start({}, off);
    expect(await finish(s.uploadId, 'DRV1', admin)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await finish(s.uploadId, 'DRV1')).toMatchObject({ ok: false });
    expect((await finish(s.uploadId, 'DRV1', off)).ok).toBe(true);
    expect((await finish(s.uploadId, 'DRV1', off)).ok).toBe(false);
  });

  it('finish with a foreign driveFileId is rejected and never deletes it', async () => {
    const s = await start({}, off);
    const r = await finish(s.uploadId, 'ROOTFOLDER', off);
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await rows("SELECT id FROM drive_files WHERE id = ? AND upload_url <> ''", s.uploadId)).toHaveLength(1);
  });

  it('finish while the session is incomplete (308) keeps the row, no delete', async () => {
    const s = await start({}, off);
    chunkStatus = 308;
    expect(await finish(s.uploadId, undefined, off)).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await rows('SELECT id FROM drive_files WHERE id = ?', s.uploadId)).toHaveLength(1);
    chunkStatus = 200;
    expect((await finish(s.uploadId, undefined, off)).ok).toBe(true);
  });

  it('finish derives the file id from the session query (driveFileId optional)', async () => {
    const s = await start({}, off);
    const r = await finish(s.uploadId, undefined, off);
    expect(r).toEqual({ ok: true, url: 'https://lh3.googleusercontent.com/d/DRV1', driveFileId: 'DRV1' });
    const q = calls.find((c) => c.method === 'PUT')!;
    expect(q.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1');
    expect(q.headers.get('Content-Range')).toBe('bytes */1000');
  });

  it('guest can finish own request_attachment upload', async () => {
    const s = await start({ purpose: 'request_attachment' });
    expect((await finish(s.uploadId)).ok).toBe(true);
  });

  describe('chunk proxy', () => {
    beforeEach(() => {
      chunkStatus = 308;
    });

    const chunk = (uploadId: string, cookie?: string, headers: Record<string, string> = {}, body: BodyInit = 'abc') =>
      SELF.fetch(
        new Request(`https://example.com/api/uploads/${uploadId}/chunk`, {
          method: 'POST',
          headers: { 'Content-Range': 'bytes 0-2/1000', ...(cookie ? { Cookie: cookie } : {}), ...headers },
          body,
        }),
      );

    it('forwards body + Content-Range; 308 maps to range', async () => {
      const s = await start({}, off);
      const res = await chunk(s.uploadId, off);
      expect(await res.json()).toEqual({ ok: true, range: 'bytes=0-5242879' });
      const put = calls.find((c) => c.method === 'PUT')!;
      expect(put.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1');
      expect(put.headers.get('Content-Range')).toBe('bytes 0-2/1000');
      expect(put.body).toBe('abc');
    });

    it('200 maps to done + driveFileId', async () => {
      const s = await start({}, off);
      chunkStatus = 200;
      expect(await (await chunk(s.uploadId, off)).json()).toEqual({ ok: true, done: true, driveFileId: 'DRV1' });
    });

    it('other Google status fails generically', async () => {
      const s = await start({}, off);
      chunkStatus = 500;
      const r: any = await (await chunk(s.uploadId, off)).json();
      expect(r.ok).toBe(false);
    });

    it('rejects oversize body, other user, missing session on protected purpose', async () => {
      const s = await start({}, off);
      const big = await chunk(s.uploadId, off, { 'Content-Length': String(5242880 + 1_000_000) });
      expect(await big.json()).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(await (await chunk(s.uploadId, admin)).json()).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(await (await chunk(s.uploadId)).json()).toMatchObject({ ok: false, code: 'AUTH' });
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('rejects missing Content-Length before reading the body', async () => {
      const s = await start({}, off);
      const res = await SELF.fetch(
        new Request(`https://example.com/api/uploads/${s.uploadId}/chunk`, {
          method: 'POST',
          headers: { 'Content-Range': 'bytes 0-2/1000', Cookie: off, 'Transfer-Encoding': 'chunked' },
          body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('abc')); c.close(); } }),
          duplex: 'half',
        } as any),
      );
      expect(await res.json()).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('guest proxy works for guest request_attachment; unknown id fails', async () => {
      const s = await start({ purpose: 'request_attachment' });
      expect(((await (await chunk(s.uploadId)).json()) as any).ok).toBe(true);
      expect(((await (await chunk('F-NOPE0000')).json()) as any).ok).toBe(false);
    });
  });
});
