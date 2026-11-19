import path from 'node:path';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export async function runMigrations(connectionString?: string): Promise<void> {
  const url =
    connectionString ||
    process.env.DATABASE_ADMIN_URL ||
    'postgres://harness:harness_password@127.0.0.1:5433/harness';

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  const migrationsFolder = path.resolve(import.meta.dirname, '../drizzle');
  await migrate(db, { migrationsFolder });

  // Ensure role permissions are applied on the public schema and audit_log
  await client.unsafe(`
    DO $$
    DECLARE
      db_name text;
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'harness_app') THEN
        CREATE ROLE harness_app WITH LOGIN PASSWORD 'harness_app_password';
      END IF;
      SELECT current_database() INTO db_name;
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO harness_app', db_name);
    END
    $$;
    GRANT USAGE ON SCHEMA public TO harness_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM harness_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM harness_app;

    GRANT SELECT, INSERT, UPDATE ON TABLE tasks, task_steps, approvals, verifications, repos TO harness_app;
    GRANT SELECT, INSERT ON TABLE audit_log TO harness_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO harness_app;
  `);

  await client.end();
}

// Allow running directly as CLI script
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runMigrations()
    .then(() => {
      console.log('Migrations completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
