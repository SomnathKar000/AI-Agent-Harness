import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_ADMIN_URL ||
      process.env.DATABASE_URL ||
      'postgres://harness:harness_password@127.0.0.1:5433/harness',
  },
});
