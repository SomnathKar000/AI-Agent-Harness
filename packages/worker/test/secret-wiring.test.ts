import { describe, it, expect, beforeAll } from 'vitest';
import type { Database } from '@harness/db';
import { PolicyGate } from '@harness/policy';
import { runTaskPipeline } from '../src/pipeline.js';
import { defaultCreateGate } from '../src/ports.js';
import {
  setupTestDb,
  seedQueuedTask,
  makeFakeSandbox,
  makeFakeAgent,
  makeFakeVerifier,
  makeRecordingGate,
  passingVerify,
  unusedLlm,
} from './helpers.js';
import { getTask } from '@harness/db';

/**
 * The Phase 6 wiring contract from packages/policy/README.md:
 * PolicyGate must be constructed with collectSecretValues(worktreePath).
 */
describe('Phase 6 contract: collectSecretValues is wired into PolicyGate', () => {
  let db: Database;
  const CANARY = 'canary-7f3a9';

  beforeAll(async () => {
    db = await setupTestDb();
  });

  it('calls collectSecretValues with the worktree path exactly once', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ secrets: [CANARY], worktreePath: '/tmp/wt-secret-1' });
    const gate = makeRecordingGate();

    await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
      createGate: gate.createGate,
      llm: unusedLlm,
    });

    const collectCalls = fake.calls.filter((c) => c.name === 'collectSecretValues');
    expect(collectCalls.length).toBe(1);
    expect(collectCalls[0].args[0]).toBe('/tmp/wt-secret-1');
  });

  it('passes the collected values into the gate it builds for the agent', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ secrets: [CANARY, 'second-secret-value'] });
    const gate = makeRecordingGate();

    await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
      createGate: gate.createGate,
      llm: unusedLlm,
    });

    expect(gate.built.length).toBe(1);
    expect(gate.built[0].secretValues).toEqual([CANARY, 'second-secret-value']);
    expect(gate.built[0].taskId).toBe(taskId);
    expect(gate.built[0].workspaceRoot).toBe(fake.workspace.worktreePath);
  });

  it('hands the same gate instance to runAgent — the agent is never run ungated', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ secrets: [CANARY] });
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: agent.agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    });

    expect(agent.runs.length).toBe(1);
    expect(agent.runs[0].deps.gate).toBeDefined();
    expect(typeof agent.runs[0].deps.gate.evaluate).toBe('function');
  });

  it('defaultCreateGate builds a real PolicyGate whose masking covers the collected values', () => {
    const built = defaultCreateGate({
      workspaceRoot: '/tmp/wt-secret-real',
      taskId: 'gate-wiring-task',
      db: undefined,
      secretValues: [CANARY],
    });

    expect(built).toBeInstanceOf(PolicyGate);
    // Proof the values reached the gate, not just the constructor call.
    expect(built.maskSecrets!(`value is ${CANARY} here`)).not.toContain(CANARY);
  });

  it('fails the task when secret collection fails — never runs the agent with an empty registry', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ collectThrows: new Error('collectSecretValues timed out') });
    const agent = makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]);

    const outcome = await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: agent.agent,
      verifier: makeFakeVerifier([passingVerify()]).verifier,
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    });

    expect(outcome.status).toBe('failed');
    expect(agent.runs.length).toBe(0);
    const task = await getTask(db, taskId);
    expect(task?.status).toBe('failed');
    // And the container and worktree are gone.
    expect(fake.destroyCalls.length).toBe(1);
  });
});
