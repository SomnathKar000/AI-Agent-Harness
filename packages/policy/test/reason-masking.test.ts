import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PolicyGate } from '../src/gate.js';
import {
  createDb,
  runMigrations,
  createRepo,
  createTask,
  auditLog,
  approvals,
  eq,
  type Database,
} from '@harness/db';

const ROOT_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://harness:harness_password@127.0.0.1:5433/harness';
const TEST_DB_NAME = 'harness_test';
const TEST_ADMIN_URL = ROOT_ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
const TEST_APP_URL = (
  process.env.DATABASE_URL ||
  'postgres://harness_app:harness_app_password@127.0.0.1:5433/harness'
).replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

describe('Item 3: Mask res.reason too in audit_log and approvals', { timeout: 30000 }, () => {
  let db: Database;
  let tempDir: string;

  beforeAll(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await runMigrations(TEST_ADMIN_URL);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
      }
    }
    db = createDb(TEST_APP_URL);
  }, 30000);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reason-masking-ws-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('denied run_command whose argv contains a registry secret does not store secret in reason/summary in audit_log or approvals', async () => {
    const SECRET_VALUE = 'my_super_secret_cmd_token_123';
    const taskId = `reason-mask-${Date.now()}`;
    const repoId = `repo-${taskId}`;

    await createRepo(db, {
      id: repoId,
      name: 'reason-mask-repo',
      localPath: tempDir,
      defaultBranch: 'main',
    });
    await createTask(db, {
      id: taskId,
      repoId,
      title: 'Reason Masking Test',
      description: 'Testing maskSecrets on res.reason',
      status: 'running',
      maxSteps: 5,
      maxCostUsd: '1.00',
      maxMinutes: 2,
    });

    const gate = new PolicyGate({
      ctx: {
        workspaceRoot: tempDir,
        taskId,
        callCount: 0,
      },
      db,
      secretValues: [SECRET_VALUE],
    });

    // Run command that triggers a reason embedding the argument:
    // e.g. metacharacter in argv embeds the raw arg: `Shell metacharacter ";" is forbidden in argv: "${arg}"`
    const decision = await gate.evaluate({
      id: 'call_meta',
      name: 'run_command',
      input: {
        argv: ['pnpm', `test; echo ${SECRET_VALUE}`],
      },
    });

    expect(decision.action).toBe('deny');

    // Check audit_log
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.taskId, taskId));
    const auditStr = JSON.stringify(audits);
    expect(auditStr).not.toContain(SECRET_VALUE);
    expect(auditStr).toContain('[REDACTED]');

    // Also test an ASK command whose reason might contain secret
    await gate.evaluate({
      id: 'call_ask_secret',
      name: 'write_file',
      input: {
        path: '.github/workflows/ci.yml',
        content: `name: CI with ${SECRET_VALUE}\n`,
      },
    });

    const apprs = await db
      .select()
      .from(approvals)
      .where(eq(approvals.taskId, taskId));
    const apprStr = JSON.stringify(apprs);
    expect(apprStr).not.toContain(SECRET_VALUE);
  });
});
