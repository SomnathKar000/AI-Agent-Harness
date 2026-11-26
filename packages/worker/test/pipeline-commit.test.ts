import { describe, it, expect, beforeAll } from 'vitest';
import type { Database } from '@harness/db';
import { getTask, getTaskDetail } from '@harness/db';
import { runTaskPipeline } from '../src/pipeline.js';
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

/**
 * The verifier checks the committed diff against the merge base and fails a dirty
 * worktree, so the pipeline commits before it verifies. Verifying first would check the
 * previous commit and pass on an unchanged tree.
 */
describe('Committing the agent work before verification', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  const run = (
    taskId: string,
    fake: ReturnType<typeof makeFakeSandbox>,
    onVerify?: () => void
  ) =>
    runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: {
        async verifyTask() {
          onVerify?.();
          return passingVerify();
        },
      },
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    });

  it('commits the agent work before the verifier runs', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    let commitsAtVerifyTime = -1;

    await run(taskId, fake, () => {
      commitsAtVerifyTime = fake.calls.filter((c) => c.name === 'commitWorktree').length;
    });

    // One commit for the install artifacts, one for the agent's work, both before verify.
    expect(fake.calls.filter((c) => c.name === 'commitWorktree').length).toBe(2);
    expect(commitsAtVerifyTime).toBe(2);
  });

  it('uses a fixed commit message carrying only the task id — no agent or repo content', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await run(taskId, fake);

    const commits = fake.calls.filter((c) => c.name === 'commitWorktree');
    expect(commits[commits.length - 1].args[1]).toBe(
      `harness: automated changes for task ${taskId}`
    );
  });

  it('fails the task when the branch is identical to the baseline — never approves an empty diff', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ commitCommitted: false, changedFromBase: false });
    let verifyRan = false;

    const outcome = await runTaskPipeline(taskId, {
      db,
      sandbox: fake.sandbox,
      agent: makeFakeAgent([{ status: 'done', summary: 's', rootCause: 'r' }]).agent,
      verifier: {
        async verifyTask() {
          verifyRan = true;
          return passingVerify();
        },
      },
      createGate: makeRecordingGate().createGate,
      llm: unusedLlm,
    });

    expect(outcome.status).toBe('failed');
    expect(verifyRan).toBe(false);
    const task = await getTask(db, taskId);
    expect(task?.failureReason).toContain('agent_made_no_changes');
  });

  it('a commit failure is infrastructure, not an agent verdict', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    let calls = 0;
    fake.sandbox.commitWorktree = async () => {
      calls++;
      if (calls === 1) return true; // the install-artifact commit succeeds
      throw new Error('git commit failed: index.lock exists');
    };

    await expect(run(taskId, fake)).rejects.toThrow(/commit of agent changes failed/);
  });

  it('commits the install artifacts separately and diffs the agent against that commit', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox({ headSha: 'b'.repeat(40) });

    await run(taskId, fake);

    const commits = fake.calls.filter((c) => c.name === 'commitWorktree');
    expect(commits.length).toBe(2);
    expect(commits[0].args[1]).toBe(`harness: install artifacts for task ${taskId}`);
    expect(commits[1].args[1]).toBe(`harness: automated changes for task ${taskId}`);

    const changedSince = fake.calls.find((c) => c.name === 'changedSince');
    expect(changedSince?.args[1]).toBe('b'.repeat(40));

    const detail = await getTaskDetail(db, taskId);
    const approval = detail!.approvals.find((a) => a.kind === 'final_diff');
    expect((approval!.payload as { diffBaseRef: string }).diffBaseRef).toBe('b'.repeat(40));
  });

  it('takes the baseline after installing and before the agent runs', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();

    await run(taskId, fake);

    const order = fake.calls.map((c) => c.name);
    expect(order.indexOf('installDependencies')).toBeLessThan(order.indexOf('headSha'));
    expect(order.indexOf('headSha')).toBeLessThan(order.indexOf('changedSince'));
  });

  it('an unreadable HEAD is infrastructure, not an agent verdict', async () => {
    const { taskId } = await seedQueuedTask(db);
    const fake = makeFakeSandbox();
    fake.sandbox.headSha = async () => {
      throw new Error('fatal: bad revision HEAD');
    };

    await expect(run(taskId, fake)).rejects.toThrow(/committing install artifacts failed/);
  });
});
