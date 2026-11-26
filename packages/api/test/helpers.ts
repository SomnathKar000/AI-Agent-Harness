import crypto from 'node:crypto';
import postgres from 'postgres';
import {
  createDb,
  runMigrations,
  createRepo,
  createTask,
  type Database,
} from '@harness/db';
import type { FastifyInstance } from 'fastify';
import { buildServer, type ApiDeps } from '../src/server.js';
import type { TaskQueuePort } from '../src/queue-port.js';

const ROOT_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://harness:harness_password@127.0.0.1:5433/harness';
const APP_URL_BASE =
  process.env.DATABASE_URL ||
  'postgres://harness_app:harness_app_password@127.0.0.1:5433/harness';

const adminUrlFor = (dbName: string): string =>
  ROOT_ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
const appUrlFor = (dbName: string): string =>
  APP_URL_BASE.replace(/\/[^/]+$/, `/${dbName}`);

const SETUP_LOCK_KEY = 728342;

export async function setupTestDb(dbName = 'harness_test_api'): Promise<Database> {
  const rootClient = postgres(ROOT_ADMIN_URL, { max: 1 });
  try {
    await rootClient`SELECT pg_advisory_lock(${SETUP_LOCK_KEY})`;
    const exists = await rootClient`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await rootClient.unsafe(`CREATE DATABASE "${dbName}"`);
    }
    await runMigrations(adminUrlFor(dbName));
  } finally {
    try {
      await rootClient`SELECT pg_advisory_unlock(${SETUP_LOCK_KEY})`;
    } catch {
      // released with the session anyway
    }
    await rootClient.end();
  }
  return createDb(appUrlFor(dbName));
}

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export interface TestServer {
  app: FastifyInstance;
  enqueued: string[];
  close(): Promise<void>;
}

export async function buildTestServer(
  db: Database,
  overrides?: Partial<ApiDeps>
): Promise<TestServer> {
  const enqueued: string[] = [];
  const queue: TaskQueuePort = {
    async enqueue(taskId: string): Promise<void> {
      enqueued.push(taskId);
    },
  };
  const app = buildServer({
    db,
    queue,
    token: TEST_TOKEN,
    logger: false,
    ...(overrides ?? {}),
  });
  await app.ready();
  return {
    app,
    enqueued,
    close: () => app.close(),
  };
}

export function auth(token: string = TEST_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface Seeded {
  repoId: string;
  taskId: string;
}

export async function seedRepo(db: Database): Promise<string> {
  const repoId = `api-repo-${crypto.randomUUID().slice(0, 8)}`;
  await createRepo(db, {
    id: repoId,
    name: 'api-fixture',
    localPath: '/tmp/api-fixture',
    defaultBranch: 'main',
    testCommand: 'pnpm test',
  });
  return repoId;
}

export async function seedTask(
  db: Database,
  repoId: string,
  status: 'queued' | 'failed' | 'running' = 'queued'
): Promise<string> {
  const taskId = `api-task-${crypto.randomUUID().slice(0, 8)}`;
  await createTask(db, {
    id: taskId,
    repoId,
    title: 'Seeded task',
    description: 'Seeded description',
    status,
  });
  return taskId;
}
