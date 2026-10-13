import { describe, expect, it } from 'vitest';
import { applyActor } from '../src/rpc';
import type { Session } from '../src/auth/session';

const sess: Session = { id: 'U1', role: 'officer', username: 'alice', tokenHash: 'h' };

describe('applyActor', () => {
  it('replaces spoofed actor in objects and arrays of objects', () => {
    const a = { actor: 'evil' };
    const b = [{ actor: 'evil' }, { x: 1 }, 5];
    applyActor('apiAny', sess, [a, b, 'str']);
    expect(a.actor).toBe('alice');
    expect(b).toEqual([{ actor: 'alice' }, { x: 1, actor: 'alice' }, 5]);
  });

  it('apiDeleteUsers sets args[1]', () => {
    expect(applyActor('apiDeleteUsers', sess, [['u1'], 'evil'])[1]).toBe('alice');
  });

  it('apiLogout sets args[0]', () => {
    expect(applyActor('apiLogout', sess, ['evil'])[0]).toBe('alice');
  });

  it('apiGetMyRequests defaults args[0] to session id only when falsy', () => {
    expect(applyActor('apiGetMyRequests', sess, [])[0]).toBe('U1');
    expect(applyActor('apiGetMyRequests', sess, ['X'])[0]).toBe('X');
  });

  it('apiUpdateProfile forces ID', () => {
    expect(applyActor('apiUpdateProfile', sess, [{ ID: 'evil', Name: 'n' }])[0]).toMatchObject({ ID: 'U1', Name: 'n' });
    expect(applyActor('apiUpdateProfile', sess, [])[0]).toEqual({ ID: 'U1' });
  });

  it('apiCreateRequest with session sets UserID and actor', () => {
    expect(applyActor('apiCreateRequest', sess, [{ UserID: 'evil', actor: 'evil' }])[0]).toEqual({
      UserID: 'U1',
      actor: 'alice',
    });
  });

  it('guest apiCreateRequest clears spoofed UserID and defaults actor', () => {
    expect(applyActor('apiCreateRequest', null, [{ UserID: 'U9', actor: 'evil', FullName: 'Somchai' }])[0]).toEqual({
      UserID: null,
      actor: 'Somchai',
      FullName: 'Somchai',
    });
    expect(applyActor('apiCreateRequest', null, [])[0]).toEqual({
      UserID: null,
      actor: 'ผู้ขอเบิก (บุคคลทั่วไป)',
    });
  });

  it('no session leaves other functions untouched', () => {
    const a = { actor: 'x' };
    applyActor('apiOther', null, [a]);
    expect(a.actor).toBe('x');
  });
});
