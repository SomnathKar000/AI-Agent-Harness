import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import {
  createDb,
  runMigrations,
  createRepo,
  createTask,
  transitionTask,
  appendStep,
  createApproval,
  decideApproval,
  recordVerification,
  appendAudit,
  getTaskWithSteps,
  ConcurrentTransitionError,
  type Database,
} from '../src/index.js';
import { InvalidTransitionError } from '@harness/core';

const ROOT_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://harness:harness_password@127.0.0.1:5433/harness';
const TEST_DB_NAME = 'harness_test';
const TEST_ADMIN_URL =
  ROOT_ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
const TEST_APP_URL =
  (process.env.DATABASE_URL || 'postgres://harness_app:harness_app_password@127.0.0.1:5433/harness')
    .replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

describe('Database and Repository Integration Tests', { timeout: 30000 }, () => {
  let db: Database;
  let adminClient: postgres.Sql;

  beforeAll(async () => {
    // 1. Create separate test database 'harness_test' using root admin connection
    const rootClient = postgres(ROOT_ADMIN_URL, { max: 1 });
    const exists = await rootClient`SELECT 1 FROM pg_database WHERE datname = ${TEST_DB_NAME}`;
    if (exists.length > 0) {
      await rootClient.unsafe(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid()
      `);
      await rootClient.unsafe(`DROP DATABASE ${TEST_DB_NAME}`);
    }
    await rootClient.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
    await rootClient.end();

    // 2. Run migrations on the separate harness_test database with admin role
    await runMigrations(TEST_ADMIN_URL);

    // 3. Admin client for fixture setup and checking
    adminClient = postgres(TEST_ADMIN_URL, { max: 1 });

    // 4. Runtime / repository code MUST use harness_app restricted role
    db = createDb(TEST_APP_URL);
  });

  afterAll(async () => {
    await adminClient?.end();
  });

  describe('Repository & Task State Machine', () => {
    it('illegal transition throws InvalidTransitionError', async () => {
      const repoId = `repo-${Date.now()}`;
      await createRepo(db, {
        id: repoId,
        name: 'test-repo',
        localPath: '/tmp/test',
      });

      const taskId = `task-illegal-${Date.now()}`;
      await createTask(db, {
        id: taskId,
        repoId,
        title: 'Test Illegal Transition',
        description: 'Should not jump from queued to done',
        status: 'queued',
      });

      // Transition queued -> done is not allowed by core state machine
      await expect(
        transitionTask(db, taskId, 'queued', 'done', 'agent')
      ).rejects.toThrow(InvalidTransitionError);
    });

    it('transitionTask compare-and-set handles parallel transitions; exactly one succeeds', async () => {
      const repoId = `repo-${Date.now()}`;
      await createRepo(db, {
        id: repoId,
        name: 'test-repo-cas',
        localPath: '/tmp/test',
      });

      const taskId = `task-cas-${Date.now()}`;
      await createTask(db, {
        id: taskId,
        repoId,
        title: 'Test Parallel CAS',
        description: 'Race condition test',
        status: 'queued',
      });

      // Run two parallel transitions from queued -> running
      const [result1, result2] = await Promise.allSettled([
        transitionTask(db, taskId, 'queued', 'running', 'agent', { attempt: 1 }),
        transitionTask(db, taskId, 'queued', 'running', 'human', { attempt: 2 }),
      ]);

      const fulfilled = [result1, result2].filter((r) => r.status === 'fulfilled');
      const rejected = [result1, result2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The rejected one must be ConcurrentTransitionError
      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectionReason).toBeInstanceOf(ConcurrentTransitionError);

      // Verify the task status is running in DB
      const taskWithSteps = await getTaskWithSteps(db, taskId);
      expect(taskWithSteps?.task.status).toBe('running');
    });

    it('creates, appends steps, approvals, verifications, and retrieves task with steps', async () => {
      const repoId = `repo-${Date.now()}`;
      await createRepo(db, {
        id: repoId,
        name: 'lifecycle-repo',
        localPath: '/tmp/test',
      });

      const taskId = `task-lifecycle-${Date.now()}`;
      const task = await createTask(db, {
        id: taskId,
        repoId,
        title: 'Lifecycle Task',
        description: 'Complete lifecycle test',
        status: 'queued',
      });
      expect(task.id).toBe(taskId);

      // Transition queued -> running
      const runningTask = await transitionTask(db, taskId, 'queued', 'running', 'system');
      expect(runningTask.status).toBe('running');

      // Append steps
      const step1 = await appendStep(db, {
        id: `step-1-${Date.now()}`,
        taskId,
        idx: 0,
        kind: 'llm_call',
        toolName: null,
        input: { prompt: 'Fix pagination' },
        output: { response: 'Calling tool' },
        promptTokens: 100,
        completionTokens: 50,
      });
      expect(step1.idx).toBe(0);

      const step2 = await appendStep(db, {
        id: `step-2-${Date.now()}`,
        taskId,
        idx: 1,
        kind: 'tool_call',
        toolName: 'readFile',
        input: { path: 'src/paginate.ts' },
        decision: 'allow',
      });
      expect(step2.idx).toBe(1);

      // Create and decide approval
      const approval = await createApproval(db, {
        id: `app-${Date.now()}`,
        taskId,
        stepId: step2.id,
        kind: 'tool_call',
        summary: 'Allow read src/paginate.ts',
        status: 'pending',
      });
      expect(approval.status).toBe('pending');

      const decided = await decideApproval(db, approval.id, 'approved', 'Looks good');
      expect(decided.status).toBe('approved');
      expect(decided.note).toBe('Looks good');

      // Record verification
      const verification = await recordVerification(db, {
        id: `ver-${Date.now()}`,
        taskId,
        check: 'test',
        passed: true,
        output: '1 passed',
      });
      expect(verification.passed).toBe(true);

      // Append custom audit
      const audit = await appendAudit(db, {
        taskId,
        actor: 'human',
        action: 'manual_note',
        detail: { note: 'Verified by human' },
      });
      expect(audit.action).toBe('manual_note');

      // getTaskWithSteps
      const fetched = await getTaskWithSteps(db, taskId);
      expect(fetched).not.toBeNull();
      expect(fetched?.task.id).toBe(taskId);
      expect(fetched?.steps).toHaveLength(2);
      expect(fetched?.steps[0].idx).toBe(0);
      expect(fetched?.steps[1].idx).toBe(1);
    });

    it('handles paused state, verifying->running, retry failed->queued, and rejects awaiting_approval->running', async () => {
      const repoId = `repo-state-${Date.now()}`;
      await createRepo(db, {
        id: repoId,
        name: 'state-machine-repo',
        localPath: '/tmp/test',
      });

      const taskId = `task-sm-${Date.now()}`;
      await createTask(db, {
        id: taskId,
        repoId,
        title: 'State Machine Test',
        description: 'Verify new state transitions in DB',
        status: 'queued',
      });

      // queued -> running
      await transitionTask(db, taskId, 'queued', 'running', 'agent');

      // running <-> paused (mid-run tool approvals)
      const pausedTask = await transitionTask(db, taskId, 'running', 'paused', 'agent');
      expect(pausedTask.status).toBe('paused');

      const resumedTask = await transitionTask(db, taskId, 'paused', 'running', 'human');
      expect(resumedTask.status).toBe('running');

      // running -> verifying
      await transitionTask(db, taskId, 'running', 'verifying', 'agent');

      // verifying -> running (agent fixes failed verification)
      const fixingTask = await transitionTask(db, taskId, 'verifying', 'running', 'agent');
      expect(fixingTask.status).toBe('running');

      // running -> verifying -> awaiting_approval
      await transitionTask(db, taskId, 'running', 'verifying', 'agent');
      await transitionTask(db, taskId, 'verifying', 'awaiting_approval', 'agent');

      // awaiting_approval -> running is NOT allowed
      await expect(
        transitionTask(db, taskId, 'awaiting_approval', 'running', 'agent')
      ).rejects.toThrow(InvalidTransitionError);

      // awaiting_approval -> failed -> queued (retry attempt)
      await transitionTask(db, taskId, 'awaiting_approval', 'failed', 'system');
      const retriedTask = await transitionTask(db, taskId, 'failed', 'queued', 'system');
      expect(retriedTask.status).toBe('queued');
    });
  });

  describe('Security: Append-Only Audit Log under harness_app Role', () => {
    let appClient: postgres.Sql;

    beforeAll(() => {
      // Connects AS harness_app via its own login (not SET ROLE from a superuser)
      appClient = postgres(TEST_APP_URL, { max: 1 });
    });

    afterAll(async () => {
      await appClient?.end();
    });

    it('harness_app can INSERT and SELECT on audit_log', async () => {
      // INSERT should succeed
      const inserted = await appClient`
        INSERT INTO audit_log (task_id, actor, action, detail)
        VALUES ('task-app-test', 'agent', 'test_insert', '{"ok": true}'::jsonb)
        RETURNING id, actor, action;
      `;
      expect(inserted).toHaveLength(1);
      expect(inserted[0].action).toBe('test_insert');

      const auditId = inserted[0].id;

      // SELECT should succeed
      const selected = await appClient`
        SELECT id, actor, action FROM audit_log WHERE id = ${auditId};
      `;
      expect(selected).toHaveLength(1);
      expect(selected[0].id).toBe(auditId);
    });

    it('harness_app CANNOT UPDATE audit_log (fails with permission denied)', async () => {
      // Insert a row using admin
      const [row] = await adminClient`
        INSERT INTO audit_log (task_id, actor, action, detail)
        VALUES ('task-update-test', 'system', 'original', '{"safe": true}'::jsonb)
        RETURNING id;
      `;

      // Attempting UPDATE under harness_app must fail with permission denied (error 42501)
      await expect(
        appClient`
          UPDATE audit_log SET action = 'tampered' WHERE id = ${row.id};
        `
      ).rejects.toThrow(/permission denied/i);
    });

    it('harness_app CANNOT DELETE from audit_log (fails with permission denied)', async () => {
      // Insert a row using admin
      const [row] = await adminClient`
        INSERT INTO audit_log (task_id, actor, action, detail)
        VALUES ('task-delete-test', 'system', 'original', '{"safe": true}'::jsonb)
        RETURNING id;
      `;

      // Attempting DELETE under harness_app must fail with permission denied (error 42501)
      await expect(
        appClient`
          DELETE FROM audit_log WHERE id = ${row.id};
        `
      ).rejects.toThrow(/permission denied/i);
    });

    it('harness_app CANNOT DELETE from operational tables (e.g. tasks)', async () => {
      // harness_app has SELECT, INSERT, UPDATE only (no DELETE)
      const [repo] = await adminClient`
        INSERT INTO repos (id, name, local_path)
        VALUES ('repo-del-test', 'test-del', '/tmp')
        RETURNING id;
      `;
      const [task] = await adminClient`
        INSERT INTO tasks (id, repo_id, title, description, status)
        VALUES ('task-del-test', ${repo.id}, 'title', 'desc', 'queued')
        RETURNING id;
      `;

      await expect(
        appClient`
          DELETE FROM tasks WHERE id = ${task.id};
        `
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
