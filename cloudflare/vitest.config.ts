import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, PW_SALT: 'SALT' } },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      exclude: ['test/node/**', 'node_modules/**'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
