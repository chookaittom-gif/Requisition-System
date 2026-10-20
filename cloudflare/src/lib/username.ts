/**
 * Usernames are case-insensitive: stored exactly as typed (for display),
 * compared lowered. SQL call sites use the equivalent
 * `LOWER(username) = LOWER(?)` so the rule stays in one place conceptually.
 */
export const eqUsername = (a: unknown, b: unknown): boolean =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
