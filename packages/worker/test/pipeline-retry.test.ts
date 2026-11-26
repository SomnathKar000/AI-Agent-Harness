import { describe, it, expect, beforeAll } from 'vitest';
import type { Database } from '@harness/db';
import { getTask } from '@harness/db';
import { runTaskPipeline } from '../src/pipeline.js';
import { InfraError } from '../src/errors.js';
import {
  setupTestDb,
  seedQueuedTask,
  makeFakeSandbox,
  makeFakeAgent,
  makeFakeVerifier,
  makeRecordingGate,
  passingVerify,
  failingVerify,
  unusedLlm,
} from './helpers.js';

/**
 * BullMQ retries a job when the processor throws. So: infrastructure errors throw,
 * agent and verification failures do not.
 */
describe('Retry only on infrastructure errors', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  const baseDeps = (fake: ReturnType<typeof makeFakeSandbox>) => ({
    db,
    sandbox: fake.sandbox,
    createGate: makeRecordingGate().createGate,
    llm: unusedLlm,
  });

  it('an agent "failed" result resolves (no BullMQ retry) and marks the task failed', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(taskId, {
      ...baseDeps(fake),
      agent: makeFakeAgent([{ status: 'failed', reason: 'step limit reached' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
    });

    expect(outcome.status).toBe('failed');
    const task = await getTask(db, taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failureReason).toContain('step limit reached');
  });

  it('an agent "needs_info" result resolves and does not retry', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(taskId, {
      ...baseDeps(fake),
      agent: makeFakeAgent([{ status: 'needs_info', question: 'which branch?' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
    });

    expect(outcome.status).toBe('needs_info');
    const task = await getTask(db, taskId);
    expect(task?.status).toBe('needs_info');
  });

  it('exhausted verification fix loops resolve and do not retry', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(taskId, {
      ...baseDeps(fake),
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([failingVerify(), failingVerify(), failingVerify()]).verifier,
    });

    expect(outcome.status).toBe('failed');
  });

  it('a docker failure throws InfraError so BullMQ retries', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({
      startContainerThrows: new Error('Cannot connect to the Docker daemon'),
    });

    await expect(
      runTaskPipeline(taskId, {
        ...baseDeps(fake),
        agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
        verifier: makeFakeVerifier([passingVerify()]).verifier,
      })
    ).rejects.toBeInstanceOf(InfraError);
  });

  it('a workspace creation failure throws InfraError', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    fake.sandbox.createWorkspace = async () => {
      throw new Error('git worktree add failed');
    };

    await expect(
      runTaskPipeline(taskId, {
        ...baseDeps(fake),
        agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
        verifier: makeFakeVerifier([passingVerify()]).verifier,
      })
    ).rejects.toBeInstanceOf(InfraError);
  });

  it('a failing install exit code throws InfraError', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ installExitCode: 1 });

    await expect(
      runTaskPipeline(taskId, {
        ...baseDeps(fake),
        agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
        verifier: makeFakeVerifier([passingVerify()]).verifier,
      })
    ).rejects.toBeInstanceOf(InfraError);
  });

  it('a missing task is a failure, not a retry loop, and never starts a workspace', async () => {
    const fake = makeFakeSandbox();
    const outcome = await runTaskPipeline('task-that-does-not-exist', {
      ...baseDeps(fake),
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
    });

    expect(outcome.status).toBe('failed');
    expect(fake.calls.filter((c) => c.name === 'createWorkspace').length).toBe(0);
  });

  it('a repo with an empty localPath fails closed and never creates a workspace (hard rule 13)', async () => {
    const { taskId } = await seedQueuedTask(db, { repoPath: '   ' });
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(taskId, {
      ...baseDeps(fake),
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
    });

    expect(outcome.status).toBe('failed');
    expect(fake.calls.filter((c) => c.name === 'createWorkspace').length).toBe(0);
    const task = await getTask(db, taskId);
    expect(task?.status).toBe('failed');
  });

  it('a repo with an empty defaultBranch fails closed — no silent default to main', async () => {
    const { taskId } = await seedQueuedTask(db, { defaultBranch: '' });
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(taskId, {
      ...baseDeps(fake),
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
    });

    expect(outcome.status).toBe('failed');
    expect(fake.calls.filter((c) => c.name === 'createWorkspace').length).toBe(0);
  });
});
