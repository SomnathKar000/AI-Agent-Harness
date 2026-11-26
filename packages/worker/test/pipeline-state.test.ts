import { describe, it, expect, beforeAll } from 'vitest';
import type { Database } from '@harness/db';
import { getTask, getTaskDetail, transitionTask } from '@harness/db';
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

/**
 * Every status change is a transitionTask compare-and-set, so the audit_log trail is the
 * authoritative record of what the pipeline did (hard rule 9).
 */
describe('Pipeline state transitions', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  const deps = (
    fake: ReturnType<typeof makeFakeSandbox>,
    agentResults: Parameters<typeof makeFakeAgent>[0],
    verifyResults: Parameters<typeof makeFakeVerifier>[0]
  ) => ({
    db,
    sandbox: fake.sandbox,
    agent: makeFakeAgent(agentResults).agent,
    verifier: makeFakeVerifier(verifyResults).verifier,
    createGate: makeRecordingGate().createGate,
    llm: unusedLlm,
  });

  it('happy path trail is queued->running->verifying->awaiting_approval', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(
      taskId,
      deps(fake, [{ status: 'done', summary: 's', rootCause: 'r' }], [passingVerify()])
    );

    expect(outcome.status).toBe('awaiting_approval');
    expect(await transitionTrail(db, taskId)).toEqual([
      'queued->running',
      'running->verifying',
      'verifying->awaiting_approval',
    ]);
  });

  it('records branch, worktree and container on the task row', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ worktreePath: '/tmp/wt-state-1' });

    await runTaskPipeline(
      taskId,
      deps(fake, [{ status: 'done', summary: 's', rootCause: 'r' }], [passingVerify()])
    );

    const task = await getTask(db, taskId);
    expect(task?.branchName).toBe(`harness/${taskId}`);
    expect(task?.worktreePath).toBe('/tmp/wt-state-1');
    expect(task?.containerId).toBe('fake-container-id');
  });

  it('creates exactly one final_diff approval when verification passes', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await runTaskPipeline(
      taskId,
      deps(fake, [{ status: 'done', summary: 's', rootCause: 'r' }], [passingVerify()])
    );

    const detail = await getTaskDetail(db, taskId);
    const finalDiff = detail!.approvals.filter((a) => a.kind === 'final_diff');
    expect(finalDiff.length).toBe(1);
    expect(finalDiff[0].status).toBe('pending');
  });

  it('creates no final_diff approval when verification fails', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await runTaskPipeline(
      taskId,
      deps(
        fake,
        [{ status: 'done', summary: 's', rootCause: 'r' }],
        [failingVerify(), failingVerify(), failingVerify()]
      )
    );

    const detail = await getTaskDetail(db, taskId);
    expect(detail!.approvals.filter((a) => a.kind === 'final_diff').length).toBe(0);
  });

  it('skips a task that is not queued — a duplicate job never double-runs it', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    const fake = makeFakeSandbox();

    const outcome = await runTaskPipeline(
      taskId,
      deps(fake, [{ status: 'done', summary: 's', rootCause: 'r' }], [passingVerify()])
    );

    expect(outcome.status).toBe('skipped');
    expect(fake.calls.filter((c) => c.name === 'createWorkspace').length).toBe(0);
    expect(await transitionTrail(db, taskId)).toEqual(['queued->running']);
  });

  it('writes no verify rows to task_steps — the agent loop is the only writer (hard rule 15)', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await runTaskPipeline(
      taskId,
      deps(fake, [{ status: 'done', summary: 's', rootCause: 'r' }], [passingVerify()])
    );

    const detail = await getTaskDetail(db, taskId);
    expect(detail!.steps.filter((s) => s.kind === 'verify').length).toBe(0);
  });

  it('keeps step indices monotonic across verify-fix rounds', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    const gate = makeRecordingGate();

    // Each agent run logs two steps starting at idx 1; without an offset the second run
    // would reuse indices 1 and 2.
    let run = 0;
    const agent = {
      async runAgent(
        agentTask: { id: string },
        agentDeps: { logger: { logStep: (p: Record<string, unknown>) => Promise<void> } }
      ) {
        run++;
        await agentDeps.logger.logStep({
          taskId: agentTask.id,
          idx: 1,
          kind: 'llm_call',
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
        });
        await agentDeps.logger.logStep({
          taskId: agentTask.id,
          idx: 2,
          kind: 'tool_call',
          toolName: 'read_file',
          decision: 'allow',
        });
        return { status: 'done', summary: `run ${run}`, rootCause: 'r' } as const;
      },
    };

    await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      verifier: makeFakeVerifier([failingVerify(), passingVerify()]).verifier,
      createGate: gate.createGate,
      llm: unusedLlm,
    });

    const detail = await getTaskDetail(db, taskId);
    const indices = detail!.steps.map((s) => s.idx);
    expect(indices).toEqual([1, 2, 3, 4]);
    expect(new Set(indices).size).toBe(indices.length);
  });
});
