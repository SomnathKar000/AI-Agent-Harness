import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createApproval, getTask, transitionTask, type Database } from '@harness/db';
import {
  setupTestDb,
  seedQueuedTask,
  transitionTrail,
  makeFakeSandbox,
  makeFakeAgent,
  makeFakeVerifier,
  passingVerify,
  makeRecordingGate,
  unusedLlm,
} from './helpers.js';
import { runTaskPipeline } from '../src/pipeline.js';

const DB_NAME = 'harness_test_approval_pipe';
let db: Database;

beforeAll(async () => {
  db = await setupTestDb(DB_NAME);
}, 120000);

function baseDeps(overrides: Record<string, unknown> = {}) {
  const sandbox = makeFakeSandbox();
  const gate = makeRecordingGate();
  return {
    sandbox,
    gate,
    deps: {
      db,
      sandbox: sandbox.sandbox,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
      createGate: () => gate.gate,
      llm: unusedLlm,
      ...overrides,
    },
  };
}

describe('pipeline wires a mid-run approval waiter', () => {
  it('hands the agent an approvalWaiter', async () => {
    const seeded = await seedQueuedTask(db);
    const fakeAgent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);
    const { deps } = baseDeps({ agent: fakeAgent.agent });

    await runTaskPipeline(seeded.taskId, deps as never);

    expect(fakeAgent.runs.length).toBe(1);
    expect(typeof fakeAgent.runs[0].deps.approvalWaiter?.waitForApproval).toBe('function');
  }, 60000);

  it('the injected waiter really drives running -> paused -> running', async () => {
    const seeded = await seedQueuedTask(db);
    const approvalId = crypto.randomUUID();

    // The agent asks once, mid-run, exactly as the loop would after a gate `ask`.
    const fakeAgent = makeFakeAgent([
      async () => {
        await createApproval(db, {
          id: approvalId,
          taskId: seeded.taskId,
          kind: 'tool_call',
          summary: 'run_command needs approval',
          payload: { toolCall: { id: 'c1', name: 'run_command', input: {} } },
          status: 'pending',
        });
        const waiter = lastDeps()!.approvalWaiter!;
        const pending = waiter.waitForApproval({
          taskId: seeded.taskId,
          toolCall: { id: 'c1', name: 'run_command', input: {} },
        });
        await vi.waitFor(
          async () => expect((await getTask(db, seeded.taskId))?.status).toBe('paused'),
          { timeout: 5000, interval: 25 }
        );
        await import('@harness/db').then((m) =>
          m.decideApproval(db, approvalId, 'approved', 'ok')
        );
        const outcome = await pending;
        expect(outcome.status).toBe('approved');
        return { status: 'done' as const, summary: 's', rootCause: 'r' };
      },
    ]);
    const lastDeps = () => fakeAgent.runs[fakeAgent.runs.length - 1]?.deps;

    const { deps } = baseDeps({
      agent: fakeAgent.agent,
      createApprovalWaiter: undefined,
      approvalPollMs: 25,
    });

    const result = await runTaskPipeline(seeded.taskId, deps as never);

    expect(result.status).toBe('awaiting_approval');
    const trail = await transitionTrail(db, seeded.taskId);
    expect(trail).toContain('running->paused');
    expect(trail).toContain('paused->running');
  }, 90000);

  it('a cancel while paused tears the run down and cleans up', async () => {
    const seeded = await seedQueuedTask(db);
    const approvalId = crypto.randomUUID();

    const fakeAgent = makeFakeAgent([
      async () => {
        await createApproval(db, {
          id: approvalId,
          taskId: seeded.taskId,
          kind: 'tool_call',
          summary: 'needs approval',
          payload: {},
          status: 'pending',
        });
        const waiter = fakeAgent.runs[fakeAgent.runs.length - 1].deps.approvalWaiter!;
        const pending = waiter.waitForApproval({
          taskId: seeded.taskId,
          toolCall: { id: 'c1', name: 'run_command', input: {} },
        });
        await vi.waitFor(
          async () => expect((await getTask(db, seeded.taskId))?.status).toBe('paused'),
          { timeout: 5000, interval: 25 }
        );
        await transitionTask(db, seeded.taskId, 'paused', 'cancelled', 'human');
        return await pending.then(() => ({
          status: 'done' as const,
          summary: 's',
          rootCause: 'r',
        }));
      },
    ]);

    const { sandbox, deps } = baseDeps({ agent: fakeAgent.agent, approvalPollMs: 25 });

    const result = await runTaskPipeline(seeded.taskId, deps as never);

    expect(result.status).toBe('cancelled');
    expect((await getTask(db, seeded.taskId))?.status).toBe('cancelled');
    // Cleanup still ran.
    expect(sandbox.destroyCalls.length).toBe(1);
  }, 90000);
});
