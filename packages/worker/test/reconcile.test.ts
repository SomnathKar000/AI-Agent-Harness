import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from '@harness/db';
import { getTask, transitionTask, setTaskFields } from '@harness/db';
import { reconcileOrphans, type ReconcilePorts } from '../src/reconcile.js';
import { setupTestDb, seedQueuedTask, transitionTrail } from './helpers.js';

function makePorts(
  db: Database,
  containers: { id: string; state: string; names: string[] }[],
  worktreeDirs: string[]
): {
  ports: ReconcilePorts;
  destroyed: { containerId?: string; workspace?: { worktreePath: string } }[];
  pruned: string[];
} {
  const destroyed: { containerId?: string; workspace?: { worktreePath: string } }[] = [];
  const pruned: string[] = [];
  return {
    destroyed,
    pruned,
    ports: {
      db,
      listSandboxContainers: async () => containers,
      listWorktreeDirs: async () => worktreeDirs,
      destroy: async (target) => {
        destroyed.push(target as { containerId?: string; workspace?: { worktreePath: string } });
      },
      pruneWorktrees: async (repoPath: string) => {
        pruned.push(repoPath);
      },
      removeDirectory: async (dir: string) => {
        destroyed.push({ workspace: { worktreePath: dir } });
      },
    },
  };
}

describe('Startup reconciliation', () => {
  let db: Database;

  beforeAll(async () => {
    // Own database: reconcileOrphans fails every stuck task, so it must not see the
    // tasks other test files are running concurrently.
    db = await setupTestDb('harness_test_reconcile');
  });

  it('marks a task stuck in running as failed with a worker_restart reason', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');

    const { ports } = makePorts(db, [], []);
    const report = await reconcileOrphans(ports);

    const task = await getTask(db, taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failureReason).toContain('worker_restart');
    expect(report.failedTaskIds).toContain(taskId);
    expect(await transitionTrail(db, taskId)).toEqual([
      'queued->running',
      'running->failed',
    ]);
  });

  it('marks a task stuck in verifying as failed too', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    await transitionTask(db, taskId, 'running', 'verifying', 'system');

    const { ports } = makePorts(db, [], []);
    await reconcileOrphans(ports);

    const task = await getTask(db, taskId);
    expect(task?.status).toBe('failed');
  });

  it('marks a task paused on a mid-run approval as failed (Phase 7)', async () => {
    // Nothing is waiting on the approval once the worker is gone, so approving it later
    // would do nothing. Leaving the task paused would strand it forever.
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    await transitionTask(db, taskId, 'running', 'paused', 'agent');

    const { ports } = makePorts(db, [], []);
    const report = await reconcileOrphans(ports);

    const task = await getTask(db, taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failureReason).toContain('worker_restart');
    expect(report.failedTaskIds).toContain(taskId);
  });

  it('cleans up the container and worktree of a paused task too', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    await setTaskFields(db, taskId, {
      containerId: 'container-paused',
      worktreePath: '/tmp/wt-paused',
      branchName: 'harness/paused',
    });
    await transitionTask(db, taskId, 'running', 'paused', 'agent');

    const { ports, destroyed } = makePorts(db, [], []);
    await reconcileOrphans(ports);

    expect(destroyed.some((d) => d.containerId === 'container-paused')).toBe(true);
  });

  it('leaves queued and awaiting_approval tasks alone', async () => {
    const queued = await seedQueuedTask(db);
    const awaiting = await seedQueuedTask(db);
    await transitionTask(db, awaiting.taskId, 'queued', 'running', 'system');
    await transitionTask(db, awaiting.taskId, 'running', 'verifying', 'system');
    await transitionTask(db, awaiting.taskId, 'verifying', 'awaiting_approval', 'system');

    const { ports } = makePorts(db, [], []);
    await reconcileOrphans(ports);

    expect((await getTask(db, queued.taskId))?.status).toBe('queued');
    expect((await getTask(db, awaiting.taskId))?.status).toBe('awaiting_approval');
  });

  it('destroys the container and worktree of a stuck task before failing it', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    await setTaskFields(db, taskId, {
      containerId: 'stuck-container',
      worktreePath: `/tmp/harness-worktrees/${taskId}`,
      branchName: `harness/${taskId}`,
    });

    const { ports, destroyed } = makePorts(db, [], []);
    await reconcileOrphans(ports);

    expect(destroyed.some((d) => d.containerId === 'stuck-container')).toBe(true);
    expect(
      destroyed.some((d) => d.workspace?.worktreePath === `/tmp/harness-worktrees/${taskId}`)
    ).toBe(true);
  });

  it('removes a sandbox container that no live task claims', async () => {
    const { ports, destroyed } = makePorts(
      db,
      [{ id: 'orphan-container', state: 'exited', names: ['/eager_tesla'] }],
      []
    );
    const report = await reconcileOrphans(ports);

    expect(destroyed.some((d) => d.containerId === 'orphan-container')).toBe(true);
    expect(report.removedContainerIds).toContain('orphan-container');
  });

  it('keeps a container that a non-terminal task still claims', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    await setTaskFields(db, taskId, { containerId: 'claimed-container' });

    // The reconciler is given the claimed container, and the task is simultaneously one of
    // the stuck tasks it fails. The container is removed once, by the stuck-task path, and
    // never a second time as an unclaimed orphan.
    const { ports, destroyed } = makePorts(
      db,
      [{ id: 'claimed-container', state: 'running', names: ['/claimed'] }],
      []
    );
    const report = await reconcileOrphans(ports);

    expect(destroyed.filter((d) => d.containerId === 'claimed-container').length).toBe(1);
    expect(report.removedContainerIds).not.toContain('claimed-container');
  });

  it('removes a worktree directory with no task row at all', async () => {
    const { ports, destroyed } = makePorts(db, [], ['wt-ghost-task']);
    const report = await reconcileOrphans(ports);

    const expected = path.join(os.homedir(), '.harness', 'worktrees', 'wt-ghost-task');
    expect(destroyed.some((d) => d.workspace?.worktreePath === expected)).toBe(true);
    expect(report.removedWorktreePaths).toContain(expected);
  });

  it('keeps the worktree of a queued task that has not started yet', async () => {
    const { taskId } = await seedQueuedTask(db);
    const { ports, report } = { ...makePorts(db, [], [taskId]), report: undefined };
    const result = await reconcileOrphans(ports);
    void report;

    expect(result.removedWorktreePaths).toEqual([]);
  });

  it('prunes stale worktree metadata in every known repo', async () => {
    const { repoId } = await seedQueuedTask(db, { repoPath: `/tmp/repo-${crypto.randomUUID()}` });
    void repoId;
    const { ports, pruned } = makePorts(db, [], []);
    await reconcileOrphans(ports);

    expect(pruned.length).toBeGreaterThan(0);
  });

  it('a container removal failure does not stop the rest of the reconciliation', async () => {
    const { taskId } = await seedQueuedTask(db);
    await transitionTask(db, taskId, 'queued', 'running', 'system');

    const { ports } = makePorts(
      db,
      [{ id: 'explodes', state: 'exited', names: ['/boom'] }],
      []
    );
    ports.destroy = async (target) => {
      if ((target as { containerId?: string }).containerId === 'explodes') {
        throw new Error('docker rm failed');
      }
    };

    const report = await reconcileOrphans(ports);

    // The stuck task was still failed even though the container removal threw.
    expect((await getTask(db, taskId))?.status).toBe('failed');
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('the real worktrees directory listing does not throw when the directory is absent', async () => {
    const missing = path.join(os.tmpdir(), `harness-absent-${crypto.randomUUID()}`);
    expect(fs.existsSync(missing)).toBe(false);
    const { listWorktreeDirsIn } = await import('../src/reconcile.js');
    await expect(listWorktreeDirsIn(missing)).resolves.toEqual([]);
  });
});
