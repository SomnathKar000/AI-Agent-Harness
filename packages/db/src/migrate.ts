import path from 'node:path';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export async function runMigrations(connectionString?: string): Promise<void> {
  const url =
    connectionString ||
    process.env.DATABASE_URL ||
    'postgres://harness:harness_password@127.0.0.1:5433/harness';

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  const migrationsFolder = path.resolve(import.meta.dirname, '../drizzle');
  await migrate(db, { migrationsFolder });

  // Ensure role permissions are applied on the public schema and audit_log
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'harness_app') THEN
        CREATE ROLE harness_app WITH LOGIN PASSWORD 'harness_app_password';
      END IF;
    END
    $$;
    GRANT CONNECT ON DATABASE harness TO harness_app;
    GRANT USAGE ON SCHEMA public TO harness_app;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO harness_app;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO harness_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM harness_app;
  `);

  await client.end();
}
