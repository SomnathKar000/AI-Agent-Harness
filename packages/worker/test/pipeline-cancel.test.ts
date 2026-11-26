import { describe, it, expect, beforeAll } from 'vitest';
import type { Database } from '@harness/db';
import { getTask, transitionTask } from '@harness/db';
import { runTaskPipeline } from '../src/pipeline.js';
import {
  setupTestDb,
  seedQueuedTask,
  transitionTrail,
  makeFakeSandbox,
  makeFakeAgent,
  makeFakeVerifier,
  makeRecordingGate,
  passingVerify,
  unusedLlm,
} from './helpers.js';

/**
 * Cancellation is read from Postgres, the source of truth (hard rule 9). The API sets
 * `cancelled`; the pipeline's poller sees it, destroys the container so in-flight execs
 * fail, and stops at the next step boundary.
 */
describe('Cancellation', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  const deps = (
    fake: ReturnType<typeof makeFakeSandbox>,
    agent: ReturnType<typeof makeFakeAgent>,
    cancelPollMs = 25
  ) => ({
    db,
    sandbox: fake.sandbox,
    agent: agent.agent,
    verifier: makeFakeVerifier([passingVerify()]).verifier,
    createGate: makeRecordingGate().createGate,
    llm: unusedLlm,
    cancelPollMs,
  });

  it('a task cancelled before the job starts never creates a workspace', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'cancelled', 'human');
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    const outcome = await runTaskPipeline(taskId, deps(fake, agent));

    expect(outcome.status).toBe('cancelled');
    expect(fake.calls.filter((c) => c.name === 'createWorkspace').length).toBe(0);
    expect(agent.runs.length).toBe(0);
  });

  it('a cancel during the agent run kills the container and stops the pipeline', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    // The agent "runs" while a human cancels the task, then keeps going a little longer.
    const agent = makeFakeAgent([
      async () => {
        await transitionTask(db, taskId, 'running', 'cancelled', 'human');
        await new Promise((r) => setTimeout(r, 200));
        return { status: 'done', summary: 's', rootCause: 'r' } as const;
      },
    ]);

    const outcome = await runTaskPipeline(taskId, deps(fake, agent));

    expect(outcome.status).toBe('cancelled');
    const task = await getTask(db, taskId);
    expect(task?.status).toBe('cancelled');
    // The container was destroyed by the poller while the agent was still running, and the
    // final cleanup still runs: the container must not be left behind either way.
    expect(fake.destroyCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      fake.destroyCalls.some((d) => d.containerId === 'fake-container-id')
    ).toBe(true);
    // Verification never ran on a cancelled task.
    expect(await transitionTrail(db, taskId)).toEqual([
      'queued->running',
      'running->cancelled',
    ]);
  });

  it('the pipeline does not transition an already-cancelled task again', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([
      async () => {
        await transitionTask(db, taskId, 'running', 'cancelled', 'human');
        return { status: 'done', summary: 's', rootCause: 'r' } as const;
      },
    ]);

    await runTaskPipeline(taskId, deps(fake, agent));

    const trail = await transitionTrail(db, taskId);
    expect(trail.filter((t) => t.endsWith('->cancelled')).length).toBe(1);
  });

  it('the cancel poller is stopped when the pipeline finishes', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    const outcome = await runTaskPipeline(taskId, deps(fake, agent, 10));
    expect(outcome.status).toBe('awaiting_approval');

    const destroysAfterRun = fake.destroyCalls.length;
    // Cancel the task now. A leaked interval would wake up, see 'cancelled' and destroy a
    // container that no longer belongs to this run.
    await transitionTask(db, taskId, 'awaiting_approval', 'cancelled', 'human');
    await new Promise((r) => setTimeout(r, 80));

    expect(fake.destroyCalls.length).toBe(destroysAfterRun);
  });
});
