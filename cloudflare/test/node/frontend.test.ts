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
    'num(',
  ]) {
    it(`does not contain ${banned}`, () => {
      expect(html.includes(banned)).toBe(false);
    });
  }

  it('validates JavaScript syntax in all inline script tags', () => {
    let idx = 0;
    let inlineCount = 0;
    while (true) {
      const start = html.indexOf('<script', idx);
      if (start === -1) break;
      const tagEnd = html.indexOf('>', start);
      const tagText = html.slice(start, tagEnd + 1);
      if (tagText.includes('src=')) {
        idx = tagEnd + 1;
        continue;
      }
      const closeStart = html.indexOf('</script>', tagEnd);
      const scriptContent = html.slice(tagEnd + 1, closeStart);
      expect(() => new Function(scriptContent)).not.toThrow();
      inlineCount++;
      idx = closeStart + 1;
    }
    expect(inlineCount).toBeGreaterThan(0);
  });

  it('uses the worker rpc endpoint and uploadFile', () => {
    expect(html).toContain("'/api/rpc/'");
    expect(html).toContain('uploadFile(');
    expect(html).toContain('exportInventoryXlsx(');
    expect(html).toContain('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
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
    const sdu = readFileSync(new URL('../../public/sdu-logo.jpg', import.meta.url));
    expect(ico.length).toBeGreaterThan(0);
    expect(png.length).toBeGreaterThan(0);
    expect(sdu.length).toBeGreaterThan(0);
    expect(html).toContain('/sdu-logo.jpg');
    expect(html).not.toContain('https://www.dusit.ac.th/home/wp-content/uploads/2023/07/SDU.png');
  });

  it('configures staticBackdrop and clean state for materials modal with default minQty 5', () => {
    expect(html).toContain('staticBackdrop = false');
    expect(html).toContain('staticBackdrop: true');
    expect(html).toContain('@keyframes modal-shake');
    expect(html).toContain('animate-shake');
    expect(html).not.toContain('saveMatDraft_');
    expect(html).not.toContain('getMatDraft_');
    expect(html).not.toContain('btnClearDraft');
    expect(html).toContain('formVals.MinQty !== undefined && formVals.MinQty !== \'\' ? formVals.MinQty : 5');
    expect(html).toContain('id="locCombobox"');
    expect(html).toContain('id="locDropdown"');
    expect(html).toContain('id="btnToggleLoc"');
    expect(html).toContain('สนง.ศ.ลป.');
    expect(html).toContain('สนง.รร.สาธิต');
    expect(html).toContain("const btnGenCode = $('#btnGenCode');");
  });

  it('adds a purchase-order tab for admin and officer only, exporting A4 portrait Excel', () => {
    const menus = (name: string) => {
      const start = html.indexOf(`  ${name}: [`);
      return html.slice(start, html.indexOf('],', start));
    };
    expect(menus('admin')).toContain("id:'a-po'");
    expect(menus('officer')).toContain("id:'a-po'");
    expect(menus('guest')).not.toContain("id:'a-po'");
    expect(html).toContain("'a-po': viewPurchaseOrder");
    expect(html).toContain('async function exportPurchaseOrderXlsx');
    const fn = html.slice(html.indexOf('async function exportPurchaseOrderXlsx'));
    expect(fn.slice(0, fn.indexOf('VIEW : สต๊อกการ์ด'))).toContain('paperSize: 9');
    expect(fn.slice(0, fn.indexOf('VIEW : สต๊อกการ์ด'))).toContain("orientation: 'portrait'");
    expect(fn.slice(0, fn.indexOf('VIEW : สต๊อกการ์ด'))).toContain('fitToWidth: 1');
    // remembers only reusable fields, never items/qty/price
    expect(html).toContain("const PO_DRAFT_FIELDS = ['To', 'IssName', 'IssPos']");
    expect(html).toContain("'po_draft_'");
    expect(html).toContain('id="btnPoPullLow"');
    expect(html).toContain('openPoLowStockPicker');
    expect(html).toContain('btnLowToPo');
  });

  it('purchase-order helpers compute row amounts, totals and Thai date parts', () => {
    const thM = html.match(/const TH_M\s*=\s*\[[^\]]+\];/)![0];
    const start = html.indexOf('function poRowAmount');
    const end = html.indexOf('function poThaiLine');
    const api = new Function(`${thM}\n${html.slice(start, end)}\nreturn { poRowAmount, poTotal, poThaiParts };`)();
    expect(api.poRowAmount({ qty: '3', price: '10.5' })).toBe(31.5);
    expect(api.poRowAmount({ qty: '0', price: '10' })).toBe(0);
    expect(api.poRowAmount({ qty: '2', price: '' })).toBe(0);
    expect(api.poTotal([{ qty: '3', price: '0.1' }, { qty: '2', price: '19.99' }])).toBe(40.28);
    expect(api.poTotal([])).toBe(0);
    expect(api.poThaiParts('2026-10-16')).toEqual({ d: '16', m: 'ตุลาคม', y: '2569' });
    expect(api.poThaiParts('')).toEqual({ d: '', m: '', y: '' });
  });

  it('includes shop info, budget source, acquired date, and order qty fields in material modal', () => {
    expect(html).toContain('id="mShopName"');
    expect(html).toContain('id="mShopAddress"');
    expect(html).toContain('id="mShopPhone"');
    expect(html).toContain('id="mShopTaxId"');
    expect(html).toContain('id="mBudgetSource"');
    expect(html).toContain('id="mAcquiredDate"');
    expect(html).toContain('id="mOrderQty"');
    expect(html).toContain('งบประมาณแผ่นดิน');
    expect(html).toContain('เงินบริจาค');
    expect(html).toContain('อื่นๆ');
    expect(html).toContain('ยอดคงเหลือจะตั้งต้นเท่ากับจำนวนนี้ให้อัตโนมัติ');
    expect(html).toContain('stockInp.value = orderQtyInp.value');
  });

  it('displays OrderQty in materials table and grid view', () => {
    expect(html).toContain('<th class="px-3 py-3 text-center">จำนวนที่สั่งซื้อ</th>');
    expect(html).toContain('m.OrderQty ? nf(m.OrderQty) : \'-\'');
    expect(html).toContain('คงเหลือ / สั่งซื้อ');
  });

  it('moves opening balance management to materials tab and keeps inventory report column read-only', () => {
    expect(html).not.toContain('id="btnManageOB"');
    expect(html).toContain('id="mOpeningQty"');
    expect(html).toContain('<th class="px-3 py-3 text-center bg-amber-50/60 text-amber-900 font-bold">ยอดยกมา</th>');
    expect(html).toContain('data-ob-mat');
    expect(html).toContain('openMaterialOpeningBalanceModal');
  });

  it('includes LINE notification setting and test button', () => {
    expect(html).toContain('id="fLineToken"');
    expect(html).toContain('id="toggleLineToken"');
    expect(html).toContain('id="btnTestLine"');
    expect(html).toContain('apiTestLine');
  });

  it('includes fiscal year selector and export Excel button in viewAccount', () => {
    expect(html).toContain('function currentFiscalYear()');
    expect(html).toContain('const currentFY = currentFiscalYear();');
    expect(html).toContain('id="accFY"');
    expect(html).toContain('id="btnExportAccExcel"');
    expect(html).toContain('exportAccountXlsx(');
  });

  it('supports hiding the logo in printHeader for official reports without logo', () => {
    expect(html).toContain('function printHeader(title, hideLogo = false)');
    expect(html).toContain("printHeader('บัญชีพัสดุ (ทะเบียนคุมวัสดุ)', true)");
    expect(html).toContain("printHeader('ทะเบียนรายการพัสดุ', true)");
  });

  it('paginates stock card printout with sequential page numbers', () => {
    expect(html).toContain('const rowsPerPage = 24;');
    expect(html).toContain('แผ่นที่ ${page}');
    expect(html).toContain('page-break-after:always;');
  });

  it('includes exportMaterialsXlsx with A4 page setup, borders and gridlines', () => {
    expect(html).toContain('btnExportMatExcel');
    expect(html).toContain('exportMaterialsXlsx(currentMatList || r.data)');
    expect(html).toContain('async function exportMaterialsXlsx(rows)');
    expect(html).toContain('orientation: orientation,');
    expect(html).toContain('fitToWidth: 1,');
    expect(html).toContain('fitToHeight: 0,');
    expect(html).toContain('showGridLines: true');
    expect(html).toContain('addStyledSheet');
  });

  it('applies A4 page setup and gridlines to account and inventory exports', () => {
    expect(html).toContain("orientation: 'portrait'");
    expect(html).toContain("orientation: 'landscape'");
    expect(html).toContain('showGridLines: true');
    expect(html).toContain('const THIN_BORDER =');
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

  it('formats thaiDateTime correctly for audit log and stock movements', () => {
    expect(html).toContain('esc(thaiDateTime(x.CreatedAt))');
    expect(html).toContain('esc(thaiDateTime(m.CreatedAt))');
    const thM = html.match(/const TH_M\s*=\s*\[[^\]]+\];/)![0];
    const thMs = html.match(/const TH_MS\s*=\s*\[[^\]]+\];/)![0];
    const start = html.indexOf('function thaiDate(');
    const end = html.indexOf('function todayYMD(');
    const { thaiDateTime } = new Function(`${thM}\n${thMs}\n${html.slice(start, end)}\nreturn { thaiDateTime };`)();
    expect(thaiDateTime('2026-10-19 11:25:57')).toBe('19 ตุลาคม พ.ศ. 2569 เวลา 11:25:57 น.');
    expect(thaiDateTime('2026-10-20T09:58:34')).toBe('20 ตุลาคม พ.ศ. 2569 เวลา 09:58:34 น.');
    expect(thaiDateTime('2026-10-19 11:25:57.123Z')).toBe('19 ตุลาคม พ.ศ. 2569 เวลา 11:25:57 น.');
    expect(thaiDateTime('2026-10-19')).toBe('19 ตุลาคม พ.ศ. 2569');
    expect(thaiDateTime('')).toBe('-');
    expect(thaiDateTime(null)).toBe('-');
    expect(thaiDateTime('invalid-date')).toBe('invalid-date');
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
