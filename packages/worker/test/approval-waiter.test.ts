import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  createApproval,
  decideApproval,
  getTask,
  listApprovals,
  transitionTask,
  type Database,
} from '@harness/db';
import { setupTestDb, seedQueuedTask, transitionTrail } from './helpers.js';
import { createDbApprovalWaiter } from '../src/approval-waiter.js';
import { CancelledError } from '../src/errors.js';

const DB_NAME = 'harness_test_approval';

let db: Database;

beforeAll(async () => {
  db = await setupTestDb(DB_NAME);
}, 120000);

/** The gate creates the pending row before the loop ever sees `ask`; mimic that here. */
async function seedPendingApproval(taskId: string, summary = 'run_command needs approval') {
  const id = crypto.randomUUID();
  await createApproval(db, {
    id,
    taskId,
    kind: 'tool_call',
    summary,
    payload: { toolCall: { id: 'c1', name: 'run_command', input: { argv: ['ls'] } } },
    status: 'pending',
  });
  return id;
}

async function runningTask() {
  const seeded = await seedQueuedTask(db);
  await transitionTask(db, seeded.taskId, 'queued', 'running', 'system');
  return seeded.taskId;
}

const request = (taskId: string) => ({
  taskId,
  toolCall: { id: 'c1', name: 'run_command', input: { argv: ['ls'] } },
  reason: 'requires human confirmation',
});

describe('createDbApprovalWaiter', () => {
  it('pauses the task, waits, and resumes it on approval', async () => {
    const taskId = await runningTask();
    const approvalId = await seedPendingApproval(taskId);
    const waiter = createDbApprovalWaiter({ db, taskId, pollMs: 50, timeoutMs: 10000 });

    const pending = waiter.waitForApproval(request(taskId));

    // Let it reach `paused` before deciding.
    await vi.waitFor(async () => {
      const t = await getTask(db, taskId);
      expect(t?.status).toBe('paused');
    }, { timeout: 5000, interval: 25 });

    await decideApproval(db, approvalId, 'approved', 'looks fine');
    const outcome = await pending;

    expect(outcome.status).toBe('approved');
    const after = await getTask(db, taskId);
    expect(after?.status).toBe('running');
    const trail = await transitionTrail(db, taskId);
    expect(trail).toContain('running->paused');
    expect(trail).toContain('paused->running');
  }, 30000);

  it('returns rejected with the human note and resumes the task', async () => {
    const taskId = await runningTask();
    const approvalId = await seedPendingApproval(taskId);
    const waiter = createDbApprovalWaiter({ db, taskId, pollMs: 50, timeoutMs: 10000 });

    const pending = waiter.waitForApproval(request(taskId));
    await vi.waitFor(async () => {
      expect((await getTask(db, taskId))?.status).toBe('paused');
    }, { timeout: 5000, interval: 25 });

    await decideApproval(db, approvalId, 'rejected', 'too risky');
    const outcome = await pending;

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: string }).reason).toContain('too risky');
    expect((await getTask(db, taskId))?.status).toBe('running');
  }, 30000);

  it('times out into a rejection and marks the approval row rejected (fail closed)', async () => {
    const taskId = await runningTask();
    const approvalId = await seedPendingApproval(taskId);
    const waiter = createDbApprovalWaiter({ db, taskId, pollMs: 25, timeoutMs: 300 });

    const outcome = await waiter.waitForApproval(request(taskId));

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: string }).reason).toMatch(/timed out|timeout/i);

    const rows = await listApprovals(db, { taskId });
    const row = rows.find((r) => r.id === approvalId);
    // No pending row is left behind for a human to find later.
    expect(row?.status).toBe('rejected');
    // The run is resumed so the agent can carry on with a denial.
    expect((await getTask(db, taskId))?.status).toBe('running');
  }, 30000);

  it('fails closed when there is no pending approval row to wait on', async () => {
    const taskId = await runningTask();
    const waiter = createDbApprovalWaiter({ db, taskId, pollMs: 25, timeoutMs: 1000 });

    const outcome = await waiter.waitForApproval(request(taskId));

    expect(outcome.status).toBe('rejected');
    // The task must not be left paused.
    expect((await getTask(db, taskId))?.status).toBe('running');
  }, 30000);

  it('throws CancelledError when the task is cancelled while paused', async () => {
    const taskId = await runningTask();
    await seedPendingApproval(taskId);
    const waiter = createDbApprovalWaiter({ db, taskId, pollMs: 25, timeoutMs: 10000 });

    const pending = waiter.waitForApproval(request(taskId));
    await vi.waitFor(async () => {
      expect((await getTask(db, taskId))?.status).toBe('paused');
    }, { timeout: 5000, interval: 25 });

    await transitionTask(db, taskId, 'paused', 'cancelled', 'human');

    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  }, 30000);

  it('waits on the newest pending tool_call row, not a final_diff approval', async () => {
    const taskId = await runningTask();
    await createApproval(db, {
      id: crypto.randomUUID(),
      taskId,
      kind: 'final_diff',
      summary: 'unrelated',
      payload: {},
      status: 'pending',
    });
    const approvalId = await seedPendingApproval(taskId);
    const waiter = createDbApprovalWaiter({ db, taskId, pollMs: 25, timeoutMs: 10000 });

    const pending = waiter.waitForApproval(request(taskId));
    await vi.waitFor(async () => {
      expect((await getTask(db, taskId))?.status).toBe('paused');
    }, { timeout: 5000, interval: 25 });

    await decideApproval(db, approvalId, 'approved');
    const outcome = await pending;
    expect(outcome.status).toBe('approved');
  }, 30000);
});
