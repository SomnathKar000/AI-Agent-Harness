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

describe('Pipeline always cleans up the container and worktree', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  it('destroys container and workspace on the happy path', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    });

    expect(fake.destroyCalls.length).toBe(1);
    expect(fake.destroyCalls[0].containerId).toBe('fake-container-id');
    expect(fake.destroyCalls[0].workspace?.worktreePath).toBe(fake.workspace.worktreePath);
  });

  it('destroys container and workspace when the agent throws', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([new Error('agent exploded')]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    }).catch(() => undefined);

    expect(fake.destroyCalls.length).toBe(1);
    expect(fake.destroyCalls[0].containerId).toBe('fake-container-id');
    expect(fake.destroyCalls[0].workspace).toBeDefined();
  });

  it('destroys container and workspace when the verifier throws', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([new Error('verifier exploded')]).verifier,
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    }).catch(() => undefined);

    expect(fake.destroyCalls.length).toBe(1);
    expect(fake.destroyCalls[0].containerId).toBe('fake-container-id');
  });

  it('destroys the workspace even when the container never started', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({
      startContainerThrows: new Error('docker daemon unreachable'),
    });

    await expect(
      runTaskPipeline(taskId, {
        db,
        sandbox: fake.sandbox,
        agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
        verifier: makeFakeVerifier([passingVerify()]).verifier,
        createGate: makeRecordingGate().createGate,
        llm: unusedLlm,
      })
    ).rejects.toBeInstanceOf(InfraError);

    expect(fake.destroyCalls.length).toBe(1);
    expect(fake.destroyCalls[0].containerId).toBeUndefined();
    expect(fake.destroyCalls[0].workspace?.worktreePath).toBe(fake.workspace.worktreePath);
  });

  it('destroys even when verification fails and the fix loops are exhausted', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([failingVerify(), failingVerify(), failingVerify()]).verifier,
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    });

    expect(outcome.status).toBe('failed');
    expect(fake.destroyCalls.length).toBe(1);
    const task = await getTask(db, taskId);
    expect(task?.status).toBe('failed');
  });

  it('a cleanup failure does not mask the original error', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const original = new Error('docker daemon unreachable');
    fake.sandbox.destroy = async () => {
      throw new Error('destroy also failed');
    };
    fake.sandbox.startContainer = async () => {
      throw original;
    };

    await expect(
      runTaskPipeline(taskId, {
        db,
        sandbox: fake.sandbox,
        agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
        verifier: makeFakeVerifier([passingVerify()]).verifier,
        createGate: makeRecordingGate().createGate,
        llm: unusedLlm,
      })
    ).rejects.toThrow(/docker daemon unreachable/);
  });
});
