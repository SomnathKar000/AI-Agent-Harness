import { describe, it, expect, beforeAll } from 'vitest';
import type { Database } from '@harness/db';
import { getTask } from '@harness/db';
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
  failingVerify,
  unusedLlm,
} from './helpers.js';

describe('Verify-fix loop is capped at 2', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  const run = (
    taskId: string,
    fake: ReturnType<typeof makeFakeSandbox>,
    agent: ReturnType<typeof makeFakeAgent>,
    verifyResults: Parameters<typeof makeFakeVerifier>[0],
    maxVerifyFixLoops?: number
  ) =>
    runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: agent.agent,
      verifier: makeFakeVerifier(verifyResults).verifier,
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
      maxVerifyFixLoops,
    });

  it('three failing verifications means three agent runs and a failed task', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    const outcome = await run(taskId, fake, agent, [
      failingVerify('round 1'),
      failingVerify('round 2'),
      failingVerify('round 3'),
      failingVerify('round 4 must never happen'),
    ]);

    expect(outcome.status).toBe('failed');
    // 1 initial run + at most 2 fix runs.
    expect(agent.runs.length).toBe(3);
    expect(await transitionTrail(db, taskId)).toEqual([
      'queued->running',
      'running->verifying',
      'verifying->running',
      'running->verifying',
      'verifying->running',
      'running->verifying',
      'verifying->failed',
    ]);
  });

  it('a fix that passes on the second round ends in awaiting_approval', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    const outcome = await run(taskId, fake, agent, [failingVerify('round 1'), passingVerify()]);

    expect(outcome.status).toBe('awaiting_approval');
    expect(agent.runs.length).toBe(2);
    expect(await transitionTrail(db, taskId)).toEqual([
      'queued->running',
      'running->verifying',
      'verifying->running',
      'running->verifying',
      'verifying->awaiting_approval',
    ]);
  });

  it('feeds the failed check output back into the fix run', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    await run(taskId, fake, agent, [failingVerify('ReferenceError: paginate is not defined'), passingVerify()]);

    expect(agent.runs.length).toBe(2);
    expect(agent.runs[1].task.description).toContain('ReferenceError: paginate is not defined');
  });

  it('maxVerifyFixLoops of 0 means one verification and no fix run', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    const outcome = await run(taskId, fake, agent, [failingVerify(), passingVerify()], 0);

    expect(outcome.status).toBe('failed');
    expect(agent.runs.length).toBe(1);
  });

  it('an agent that gives up during a fix round fails the task', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const agent = makeFakeAgent([
      { status: 'done', summary: 's', rootCause: 'r' },
      { status: 'failed', reason: 'cannot fix' },
    ]);

    const outcome = await run(taskId, fake, agent, [failingVerify(), passingVerify()]);

    expect(outcome.status).toBe('failed');
    const task = await getTask(db, taskId);
    expect(task?.failureReason).toContain('cannot fix');
  });
});
