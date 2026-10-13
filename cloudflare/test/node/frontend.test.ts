import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

describe('public/index.html static checks', () => {
  for (const banned of [
    'google.script.run',
    'GAS_URL',
    'IN_GAS',
    'supply_token',
    'fileToPayload(',
    'apiExportInventoryReportSheet',
    'imageFile',
    'docFile',
    'attachFile',
  ]) {
    it(`does not contain ${banned}`, () => {
      expect(html.includes(banned)).toBe(false);
    });
  }

  it('uses the worker rpc endpoint and uploadFile', () => {
    expect(html).toContain("'/api/rpc/'");
    expect(html).toContain('uploadFile(');
    expect(html).toContain('exportInventoryXlsx(');
    expect(html).toContain('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    expect(html).toContain('apiStartUpload');
    expect(html).toContain('apiFinishUpload');
    expect(html).toContain('/chunk');
    expect(html).toContain('26214400');
    expect(html).toContain('5242880');
  });

  it('maps file extensions to allowlisted MIME types when file.type is empty', () => {
    expect(html).toContain('UPLOAD_EXT_MIME');
    expect(html).toContain('uploadMimeOf_(');
    for (const [ext, mime] of [
      ['doc', 'application/msword'],
      ['xls', 'application/vnd.ms-excel'],
      ['jpg', 'image/jpeg'],
      ['pdf', 'application/pdf'],
    ]) {
      expect(html).toContain(`${ext}:'${mime}'`);
    }
  });

  it('builds the stock card from dayOut, not stock movements', () => {
    expect(html).toContain('rep.dayOut');
    const start = html.indexOf('async function exportInventoryXlsx');
    const body = html.slice(start, html.indexOf('XLSX.writeFile', start));
    expect(body).not.toContain('apiGetStockMovements');
  });

  it('keeps the upload regexes correctly escaped', () => {
    expect(html).toContain(String.raw`/bytes=0-(\d+)/`);
    expect(html).toContain(String.raw`!/bytes=0-\d+/.test(rg)`);
    expect(html).toContain(String.raw`/\.([A-Za-z0-9]+)$/`);
  });

  it('declares favicon links and static assets exist', () => {
    expect(html).toContain('<link rel="icon" type="image/png" href="/favicon.png">');
    expect(html).toContain('<link rel="shortcut icon" href="/favicon.ico">');
    const ico = readFileSync(new URL('../../public/favicon.ico', import.meta.url));
    const png = readFileSync(new URL('../../public/favicon.png', import.meta.url));
    expect(ico.length).toBeGreaterThan(0);
    expect(png.length).toBeGreaterThan(0);
  });
});

/** Runs the real upload helpers from the page against a mocked fetch/api. */
function loadUpload(fetchMock: (url: string, init: any) => Promise<Response>, apiMock: (fn: string, arg: any) => Promise<any>) {
  const from = html.indexOf('const UPLOAD_MAX_BYTES');
  const to = html.indexOf('async function uploadPicked_');
  const src = html.slice(from, to);
  const factory = new Function(
    'fetch', 'api', 'forceLogout_',
    `${src}; return { uploadFile, uploadMimeOf_, uploadNextFromRange_ };`,
  );
  return factory(fetchMock, apiMock, () => {}) as {
    uploadFile: (f: File, p: string, cb?: (n: number) => void) => Promise<{ url: string; driveFileId: string }>;
    uploadMimeOf_: (f: { type: string; name: string }) => string;
    uploadNextFromRange_: (r: string) => number;
  };
}
const okApi = async (fn: string) =>
  fn === 'apiStartUpload'
    ? { ok: true, uploadId: 'F1', uploadUrl: 'https://www.googleapis.com/u' }
    : { ok: true, url: 'https://drive.google.com/file/d/X/view', driveFileId: 'X' };

describe('upload helpers (executed from the page source)', () => {
  it('maps extensions and parses Range', () => {
    const u = loadUpload(async () => new Response(), okApi);
    expect(u.uploadMimeOf_({ type: '', name: 'a.DOC' })).toBe('application/msword');
    expect(u.uploadMimeOf_({ type: '', name: 'a.xls' })).toBe('application/vnd.ms-excel');
    expect(u.uploadMimeOf_({ type: '', name: 'a.exe' })).toBe('');
    expect(u.uploadMimeOf_({ type: 'application/x-foo', name: 'a.pdf' })).toBe('');
    expect(u.uploadMimeOf_({ type: 'image/png', name: 'a' })).toBe('image/png');
    expect(u.uploadNextFromRange_('bytes=0-5242879')).toBe(5242880);
    expect(u.uploadNextFromRange_('')).toBe(0);
  });

  it('308 with a readable Range continues from it; unreadable Range asks the proxy', async () => {
    const calls: string[] = [];
    const size = 5242880 + 100;
    const fetchMock = async (url: string, init: any) => {
      const cr = init.headers['Content-Range'];
      calls.push((url.includes('/chunk') ? 'POST ' : 'PUT ') + cr);
      if (url.includes('/chunk')) {
        return Response.json({ ok: true, range: 'bytes=0-5242879' });
      }
      if (cr.startsWith('bytes 0-')) return new Response(null, { status: 308 }); // no Range header readable
      return new Response('{"id":"X"}', { status: 200 });
    };
    const u = loadUpload(fetchMock, okApi);
    const file = new File([new Uint8Array(size)], 'a.pdf', { type: 'application/pdf' });
    const r = await u.uploadFile(file, 'material_file');
    expect(r.driveFileId).toBe('X');
    expect(calls).toEqual([
      `PUT bytes 0-5242879/${size}`,
      `POST bytes */${size}`,
      `PUT bytes 5242880-${size - 1}/${size}`,
    ]);
  });

  it('308 with Range bytes=0-N proceeds without querying the proxy', async () => {
    const calls: string[] = [];
    const size = 5242880 + 100;
    const fetchMock = async (url: string, init: any) => {
      const cr = init.headers['Content-Range'];
      calls.push(cr);
      return cr.startsWith('bytes 0-')
        ? new Response(null, { status: 308, headers: { Range: 'bytes=0-5242879' } })
        : new Response('{"id":"X"}', { status: 200 });
    };
    const u = loadUpload(fetchMock, okApi);
    await u.uploadFile(new File([new Uint8Array(size)], 'a.pdf', { type: 'application/pdf' }), 'material_file');
    expect(calls).toEqual([`bytes 0-5242879/${size}`, `bytes 5242880-${size - 1}/${size}`]);
  });
});
