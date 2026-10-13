import { getSession } from '../auth/session';
import { fail, json } from '../http';
import {
  ALLOWED_MIME,
  CHUNK_SIZE,
  DRIVE_API,
  driveFetch,
  ensureSubfolder,
  MAX_UPLOAD_BYTES,
  type FolderName,
} from '../lib/drive';
import { genId } from '../lib/ids';
import { nowBkk } from '../lib/time';
import { registerRpc, type Ctx } from '../rpc';

type Purpose = 'material_image' | 'material_file' | 'request_attachment' | 'logo' | 'banner';
type Need = 'anyone' | 'officer' | 'admin';

const PURPOSES: Record<Purpose, { folder: FolderName; need: Need }> = {
  material_image: { folder: 'MaterialImages', need: 'officer' },
  material_file: { folder: 'MaterialFiles', need: 'officer' },
  request_attachment: { folder: 'RequestAttachments', need: 'anyone' },
  logo: { folder: 'Logo', need: 'admin' },
  banner: { folder: 'Banner', need: 'admin' },
};
const RANK = { admin: 2, officer: 1, staff: 1 } as const;
const NEED_RANK: Record<Need, number> = { anyone: 0, officer: 1, admin: 2 };
const PENDING_TTL_MS = 24 * 3600_000;
const CHUNK_SLACK = 1024;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const MSG_AUTH = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
const MSG_FORBIDDEN = 'ไม่มีสิทธิ์ใช้งานส่วนนี้';
const MSG_GENERIC = 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่';
const MSG_NOT_FOUND = 'ไม่พบรายการอัปโหลดหรือหมดอายุแล้ว';

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Per-purpose access; returns a failure payload or null when allowed. */
function checkAccess(ctx: Ctx, purpose: Purpose) {
  const need = PURPOSES[purpose].need;
  if (need === 'anyone') return null;
  if (!ctx.session) return fail(MSG_AUTH, 'AUTH');
  if ((RANK[ctx.session.role] ?? 0) < NEED_RANK[need]) return fail(MSG_FORBIDDEN, 'FORBIDDEN');
  return null;
}

interface PendingRow {
  id: string;
  entity: Purpose;
  folder: FolderName;
  mime_type: string;
  size_bytes: number;
  upload_url: string;
  upload_owner: string;
}

/** Loads a live pending row and enforces purpose access + owner. Returns row or a failure payload. */
async function loadPending(ctx: Ctx, uploadId: unknown) {
  if (typeof uploadId !== 'string' || !uploadId) return { err: fail(MSG_NOT_FOUND, 'VALIDATION') };
  const row = await ctx.env.DB.prepare(
    "SELECT id, entity, folder, mime_type, size_bytes, upload_url, upload_owner FROM drive_files WHERE id = ? AND drive_file_id LIKE 'pending:%' AND upload_url <> '' AND created_at > ?",
  )
    .bind(uploadId, nowBkk(new Date(Date.now() - PENDING_TTL_MS)))
    .first<PendingRow>();
  if (!row || !(row.entity in PURPOSES)) return { err: fail(MSG_NOT_FOUND, 'VALIDATION') };
  const denied = checkAccess(ctx, row.entity);
  if (denied) return { err: denied };
  if (row.upload_owner !== (ctx.session?.id ?? '')) return { err: fail(MSG_FORBIDDEN, 'FORBIDDEN') };
  return { row };
}

registerRpc('apiStartUpload', 'public', async (ctx, args) => {
  try {
    const p = obj(args[0]);
    const purpose = p.purpose as Purpose;
    if (typeof purpose !== 'string' || !Object.hasOwn(PURPOSES, purpose)) {
      return fail('ประเภทไฟล์ไม่ถูกต้อง', 'VALIDATION');
    }
    const denied = checkAccess(ctx, purpose);
    if (denied) return denied;
    if (!ctx.session) {
      const { success } = await ctx.env.GUEST_LIMITER.limit({ key: ctx.ip });
      if (!success) return fail('ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMIT');
    }
    const fileName = typeof p.fileName === 'string' ? p.fileName.trim().slice(0, 200) : '';
    const mimeType = typeof p.mimeType === 'string' ? p.mimeType : '';
    const size = p.size;
    if (!fileName) return fail('ไม่พบชื่อไฟล์', 'VALIDATION');
    if (!ALLOWED_MIME.has(mimeType)) return fail('ชนิดไฟล์ไม่รองรับ', 'VALIDATION');
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return fail('ขนาดไฟล์ไม่ถูกต้อง', 'VALIDATION');
    if (size > MAX_UPLOAD_BYTES) return fail('ไฟล์มีขนาดเกิน 25 MB', 'VALIDATION');

    const { folder } = PURPOSES[purpose];
    const parent = await ensureSubfolder(ctx.env, folder);
    const origin = ctx.req.headers.get('Origin') || new URL(ctx.req.url).origin;
    const res = await driveFetch(
      ctx.env,
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,mimeType,size',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size),
          Origin: origin,
        },
        body: JSON.stringify({ name: fileName, mimeType, parents: [parent] }),
      },
    );
    const uploadUrl = res.headers.get('Location');
    let locOk = false;
    try {
      locOk = !!uploadUrl && new URL(uploadUrl).origin === 'https://www.googleapis.com';
    } catch {
      locOk = false;
    }
    if (!res.ok || !uploadUrl || !locOk) throw new Error(`${MSG_GENERIC} (${res.status})`);

    const uploadId = genId('F');
    await ctx.env.DB.prepare(
      "INSERT INTO drive_files (id, drive_file_id, entity, entity_id, folder, file_name, mime_type, size_bytes, url, created_by, created_at, upload_url, upload_owner) VALUES (?, ?, ?, '', ?, ?, ?, ?, '', ?, ?, ?, ?)",
    )
      .bind(
        uploadId,
        'pending:' + uploadId,
        purpose,
        folder,
        fileName,
        mimeType,
        size,
        ctx.session?.username ?? 'guest',
        nowBkk(),
        uploadUrl,
        ctx.session?.id ?? '',
      )
      .run();
    return { ok: true, uploadId, uploadUrl, chunkSize: CHUNK_SIZE };
  } catch (err) {
    console.error('apiStartUpload failed', (err as Error)?.message);
    return fail(MSG_GENERIC);
  }
});

registerRpc('apiFinishUpload', 'public', async (ctx, args) => {
  try {
    const p = obj(args[0]);
    const { row, err } = await loadPending(ctx, p.uploadId);
    if (!row) return err;
    // Bind the file to the upload session: ask Google which file this session produced.
    const q = await fetch(row.upload_url, {
      method: 'PUT',
      headers: { 'Content-Length': '0', 'Content-Range': `bytes */${row.size_bytes}` },
      redirect: 'manual',
    });
    if (q.status === 308) return fail('อัปโหลดยังไม่เสร็จ กรุณาลองใหม่', 'VALIDATION');
    if (q.status !== 200 && q.status !== 201) {
      console.error('finish session query status', q.status);
      return fail(MSG_GENERIC);
    }
    const driveFileId = ((await q.json().catch(() => null)) as { id?: string } | null)?.id;
    if (typeof driveFileId !== 'string' || !DRIVE_ID.test(driveFileId)) return fail(MSG_GENERIC);
    if (p.driveFileId !== undefined && p.driveFileId !== driveFileId) {
      return fail('ไฟล์ไม่ตรงกับรายการอัปโหลด', 'VALIDATION');
    }

    const metaRes = await driveFetch(
      ctx.env,
      `${DRIVE_API}/files/${driveFileId}?fields=${encodeURIComponent('id,name,mimeType,size,parents')}`,
    );
    if (!metaRes.ok) return fail(MSG_GENERIC);
    const meta = (await metaRes.json()) as { mimeType?: string; size?: string; parents?: string[] };

    const expectedParent = await ensureSubfolder(ctx.env, row.folder);
    const size = Number(meta.size);
    const bad =
      !meta.parents?.includes(expectedParent) ||
      !ALLOWED_MIME.has(meta.mimeType ?? '') ||
      !Number.isFinite(size) ||
      size > MAX_UPLOAD_BYTES ||
      size !== row.size_bytes;
    if (bad) {
      await driveFetch(ctx.env, `${DRIVE_API}/files/${driveFileId}`, { method: 'DELETE' }).catch(() => null);
      await ctx.env.DB.prepare('DELETE FROM drive_files WHERE id = ?').bind(row.id).run();
      return fail('ไฟล์ไม่ผ่านการตรวจสอบ (ชนิด ขนาด หรือโฟลเดอร์ไม่ถูกต้อง)', 'VALIDATION');
    }

    const perm = await driveFetch(ctx.env, `${DRIVE_API}/files/${driveFileId}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    if (!perm.ok) return fail(MSG_GENERIC);

    const url = (meta.mimeType ?? '').startsWith('image/')
      ? `https://lh3.googleusercontent.com/d/${driveFileId}`
      : `https://drive.google.com/file/d/${driveFileId}/view`;
    const upd = await ctx.env.DB.prepare(
      "UPDATE drive_files SET drive_file_id = ?, url = ?, upload_url = '' WHERE id = ? AND upload_url <> ''",
    )
      .bind(driveFileId, url, row.id)
      .run();
    if (!upd.meta.changes) return fail(MSG_NOT_FOUND, 'VALIDATION');
    return { ok: true, url, driveFileId };
  } catch (err) {
    console.error('apiFinishUpload failed', (err as Error)?.message);
    return fail(MSG_GENERIC);
  }
});

/** POST /api/uploads/:uploadId/chunk — proxy fallback for browsers that cannot PUT to Google directly. */
export async function handleChunk(ctx: Ctx, uploadId: string): Promise<Response> {
  try {
    ctx.session = await getSession(ctx);
    const { row, err } = await loadPending(ctx, uploadId);
    if (!row) return json(err);

    const range = ctx.req.headers.get('Content-Range');
    if (!range) return json(fail('ไม่พบ Content-Range', 'VALIDATION'), { status: 400 });
    const lenHeader = ctx.req.headers.get('Content-Length');
    if (lenHeader === null || !/^\d+$/.test(lenHeader)) {
      return json(fail('ต้องระบุ Content-Length', 'VALIDATION'), { status: 411 });
    }
    if (Number(lenHeader) > CHUNK_SIZE + CHUNK_SLACK) return json(fail('ส่วนไฟล์ใหญ่เกินกำหนด', 'VALIDATION'), { status: 413 });
    const body = await ctx.req.arrayBuffer();
    if (body.byteLength > CHUNK_SIZE + CHUNK_SLACK) return json(fail('ส่วนไฟล์ใหญ่เกินกำหนด', 'VALIDATION'), { status: 413 });

    const res = await fetch(row.upload_url, {
      method: 'PUT',
      headers: { 'Content-Range': range },
      body,
      redirect: 'manual',
    });
    if (res.status === 308) return json({ ok: true, range: res.headers.get('Range') ?? '' });
    if (res.status === 200 || res.status === 201) {
      const data = (await res.json().catch(() => null)) as { id?: string } | null;
      if (!data?.id) return json(fail(MSG_GENERIC), { status: 502 });
      return json({ ok: true, done: true, driveFileId: data.id });
    }
    console.error('chunk proxy upstream status', res.status);
    return json(fail(MSG_GENERIC), { status: 502 });
  } catch (err) {
    console.error('chunk proxy failed', (err as Error)?.message);
    return json(fail(MSG_GENERIC), { status: 500 });
  }
}
