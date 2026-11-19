import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export function createDb(connectionString?: string): Database {
  const url =
    connectionString ||
    process.env.DATABASE_URL ||
    'postgres://harness:harness_password@127.0.0.1:5433/harness';

  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}
