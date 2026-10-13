export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GUEST_LIMITER: RateLimit;
  PW_SALT: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  DRIVE_ROOT_FOLDER_ID: string;
}
