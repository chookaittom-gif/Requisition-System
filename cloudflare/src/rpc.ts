import type { Env } from './env';
import { getSession, type Session } from './auth/session';
import { fail, isWithHeaders, json } from './http';

export type Access = 'public' | 'officer' | 'admin';

export interface Ctx {
  env: Env;
  req: Request;
  exec: ExecutionContext;
  session: Session | null;
  ip: string;
}

export type RpcHandler = (ctx: Ctx, args: unknown[]) => Promise<unknown>;

const registry = new Map<string, { access: Access; handler: RpcHandler }>();

export function registerRpc(fn: string, access: Access, handler: RpcHandler): void {
  registry.set(fn, { access, handler });
}

const ROLE_RANK = { admin: 2, officer: 1, staff: 1 } as const;
const ACCESS_RANK: Record<Access, number> = { public: 0, officer: 1, admin: 2 };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Overwrite client-supplied identity fields from the session (mirrors dispatch_ in Code/code.gs). */
export function applyActor(fn: string, session: Session | null, args: unknown[]): unknown[] {
  if (session) {
    for (const a of args) {
      if (Array.isArray(a)) {
        for (const it of a) if (isObj(it)) it.actor = session.username;
      } else if (isObj(a)) a.actor = session.username;
    }
    if (fn === 'apiDeleteUsers') args[1] = session.username;
    if (fn === 'apiLogout') args[0] = session.username;
    if (fn === 'apiGetMyRequests' && !args[0]) args[0] = session.id;
    if (fn === 'apiUpdateProfile') {
      const p: Obj = isObj(args[0]) ? args[0] : {};
      p.ID = session.id;
      args[0] = p;
    }
    if (fn === 'apiCreateRequest') {
      const p: Obj = isObj(args[0]) ? args[0] : {};
      p.UserID = session.id;
      p.actor = session.username;
      args[0] = p;
    }
  } else if (fn === 'apiCreateRequest') {
    const p: Obj = isObj(args[0]) ? args[0] : {};
    p.UserID = null;
    p.actor = p.FullName || 'ผู้ขอเบิก (บุคคลทั่วไป)';
    args[0] = p;
  }
  return args;
}

export async function handleRpc(fn: string, ctx: Ctx, args: unknown[]): Promise<Response> {
  const entry = registry.get(fn);
  if (!entry) return json(fail('ไม่พบฟังก์ชัน'), { status: 404 });

  try {
    ctx.session = await getSession(ctx);
    if (entry.access !== 'public') {
      if (!ctx.session) return json(fail('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'AUTH'));
      if ((ROLE_RANK[ctx.session.role] ?? 0) < ACCESS_RANK[entry.access]) {
        return json(fail('ไม่มีสิทธิ์ใช้งานส่วนนี้', 'FORBIDDEN'));
      }
    }
    const result = await entry.handler(ctx, applyActor(fn, ctx.session, args));
    if (isWithHeaders(result)) {
      const res = json(result.body);
      for (const [k, v] of Object.entries(result.headers)) {
        for (const val of Array.isArray(v) ? v : [v]) res.headers.append(k, val);
      }
      return res;
    }
    return json(result);
  } catch (err) {
    console.error(`rpc ${fn} failed`, err);
    return json(fail(String((err as Error)?.message ?? err)));
  }
}
