import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { registerRpc } from '../src/rpc';

registerRpc('testOfficerFn', 'officer', async () => ({ ok: true }));

const post = (fn: string, body: unknown) =>
  SELF.fetch(
    new Request(`https://example.com/api/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('rpc dispatcher', () => {
  it('unknown function returns legacy not-found', async () => {
    const res = await post('apiNope', { args: [] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, message: 'ไม่พบฟังก์ชัน' });
  });

  it('GET on rpc is rejected', async () => {
    const res = await SELF.fetch(new Request('https://example.com/api/rpc/apiGetBootstrap'));
    expect(res.status).toBe(405);
  });

  it('officer function without session returns AUTH', async () => {
    const res = await post('testOfficerFn', { args: [] });
    expect(await res.json()).toEqual({
      ok: false,
      message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
      code: 'AUTH',
    });
  });

  it('non-api path serves index', async () => {
    const res = await SELF.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(200);
  });

  it('body args must be an array', async () => {
    const res = await post('testOfficerFn', { args: 'x' });
    expect(await res.json()).toMatchObject({ ok: false, code: 'VALIDATION' });
  });
});
