import type { Env } from './env';
import './api/admin';
import './api/auth';
import './api/materials';
import './api/requests';
import './api/reports';
import './api/shops';
import './api/personnel';
import { handleChunk } from './api/uploads';
import { runLowStockCron } from './cron';
import { fail, json } from './http';
import { handleRpc, type Ctx } from './rpc';

const RPC_PREFIX = '/api/rpc/';

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith(RPC_PREFIX)) {
      if (req.method !== 'POST') {
        return json(fail('Method Not Allowed'), { status: 405, headers: { Allow: 'POST' } });
      }
      let fn: string;
      try {
        fn = decodeURIComponent(url.pathname.slice(RPC_PREFIX.length));
      } catch {
        return json(fail('ไม่พบฟังก์ชัน'), { status: 404 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(fail('รูปแบบข้อมูลไม่ถูกต้อง', 'VALIDATION'), { status: 400 });
      }
      const args = (body as { args?: unknown } | null)?.args;
      if (!Array.isArray(args)) {
        return json(fail('args ต้องเป็นอาร์เรย์', 'VALIDATION'), { status: 400 });
      }
      const ctx: Ctx = {
        env,
        req,
        exec,
        session: null,
        ip: req.headers.get('CF-Connecting-IP') ?? '',
      };
      return handleRpc(fn, ctx, args);
    }
    const chunkMatch = /^\/api\/uploads\/([^/]+)\/chunk$/.exec(url.pathname);
    if (chunkMatch) {
      if (req.method !== 'POST') {
        return json(fail('Method Not Allowed'), { status: 405, headers: { Allow: 'POST' } });
      }
      let uploadId: string;
      try {
        uploadId = decodeURIComponent(chunkMatch[1]);
      } catch {
        return json(fail('ไม่พบรายการอัปโหลดหรือหมดอายุแล้ว', 'VALIDATION'), { status: 404 });
      }
      return handleChunk(
        { env, req, exec, session: null, ip: req.headers.get('CF-Connecting-IP') ?? '' },
        uploadId,
      );
    }
    if (url.pathname.startsWith('/api/')) {
      return json(fail('ไม่พบฟังก์ชัน'), { status: 404 });
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    exec.waitUntil(runLowStockCron(env));
  },
} satisfies ExportedHandler<Env>;
