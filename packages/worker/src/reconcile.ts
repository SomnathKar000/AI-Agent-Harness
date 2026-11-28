import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TERMINAL_STATUSES, type TaskStatus } from '@harness/core';
import {
  findTasksByStatus,
  listRepos,
  listTasks,
  getTask,
  setTaskFields,
  transitionTask,
  type Database,
} from '@harness/db';
import {
  listSandboxContainers,
  destroy as realDestroy,
  runGit,
  type Workspace,
} from '@harness/sandbox';

/**
 * Statuses a task cannot still be in once no worker is running it.
 *
 * `paused` is here from Phase 7 on. A paused task is one whose agent loop is blocked
 * waiting for a human to decide a tool approval; that wait lives in the worker process.
 * Once the process is gone nothing is listening, so a later approval would resolve
 * nothing and the task would sit paused forever.
 */
export const STUCK_STATUSES: readonly TaskStatus[] = [
  'running',
  'paused',
  'verifying',
  'pushing',
];

/** Statuses whose worktree is still legitimately in use or not yet created. */
const LIVE_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'paused',
  'needs_info',
  'verifying',
  'awaiting_approval',
  'pushing',
];

export interface ReconcilePorts {
  db: Database;
  listSandboxContainers(): Promise<{ id: string; state: string; names: string[] }[]>;
  /** Directory names under ~/.harness/worktrees. */
  listWorktreeDirs(): Promise<string[]>;
  destroy(target: { containerId?: string; workspace?: Workspace }): Promise<void>;
  pruneWorktrees(repoPath: string): Promise<void>;
  removeDirectory(dir: string): Promise<void>;
}

export interface ReconcileReport {
  failedTaskIds: string[];
  removedContainerIds: string[];
  removedWorktreePaths: string[];
  prunedRepoPaths: string[];
  errors: string[];
}

export function worktreesRoot(): string {
  return path.join(os.homedir(), '.harness', 'worktrees');
}

/** Lists directory names in `dir`. A missing directory is an empty list, not a throw. */
export async function listWorktreeDirsIn(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export const defaultReconcilePorts = (db: Database): ReconcilePorts => ({
  db,
  listSandboxContainers: () => listSandboxContainers(),
  listWorktreeDirs: () => listWorktreeDirsIn(worktreesRoot()),
  destroy: (target) => realDestroy(target),
  pruneWorktrees: async (repoPath: string) => {
    // Host git only ever runs through runGit (hard rule 6).
    await runGit(repoPath, ['worktree', 'prune']);
  },
  removeDirectory: async (dir: string) => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  },
});

/**
 * Startup reconciliation.
 *
 * A worker killed mid-task leaves a container, a worktree and a task row that says
 * `running`. None of those recover on their own, so the next start cleans them up and marks
 * the task failed. Every step is best effort and records its error rather than aborting the
 * rest: a Docker hiccup must not leave the task table lying about what is running.
 */
export async function reconcileOrphans(ports: ReconcilePorts): Promise<ReconcileReport> {
  const { db } = ports;
  const report: ReconcileReport = {
    failedTaskIds: [],
    removedContainerIds: [],
    removedWorktreePaths: [],
    prunedRepoPaths: [],
    errors: [],
  };

  const note = (context: string, err: unknown): void => {
    report.errors.push(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  };

  // 1. Tasks that claim to be in flight. Clean their resources, then fail them.
  const stuck = await findTasksByStatus(db, STUCK_STATUSES);
  const handledContainerIds = new Set<string>();

  for (const task of stuck) {
    const workspace: Workspace | undefined =
      task.worktreePath && task.branchName
        ? {
            taskId: task.id,
            repoPath: '',
            worktreePath: task.worktreePath,
            branch: task.branchName,
            baseBranch: 'main',
          }
        : undefined;

    // The repo path is what makes `git worktree remove` work; fill it in when we have it.
    if (workspace) {
      const repos = await listRepos(db).catch(() => []);
      const repo = repos.find((r) => r.id === task.repoId);
      if (repo) {
        workspace.repoPath = repo.localPath;
        workspace.baseBranch = repo.defaultBranch;
      }
    }

    if (task.containerId) {
      handledContainerIds.add(task.containerId);
    }

    try {
      await ports.destroy({
        containerId: task.containerId ?? undefined,
        workspace: workspace?.repoPath ? workspace : undefined,
      });
    } catch (err) {
      note(`destroy resources of task ${task.id}`, err);
    }

    // A worktree whose repo we could not resolve still has to go.
    if (workspace && !workspace.repoPath) {
      try {
        await ports.removeDirectory(workspace.worktreePath);
        report.removedWorktreePaths.push(workspace.worktreePath);
      } catch (err) {
        note(`remove worktree directory of task ${task.id}`, err);
      }
    }

    try {
      const reason = `worker_restart: task was '${task.status}' with no worker running it`;
      await transitionTask(db, task.id, task.status, 'failed', 'system', { reason });
      await setTaskFields(db, task.id, { failureReason: reason });
      report.failedTaskIds.push(task.id);
    } catch (err) {
      note(`mark task ${task.id} failed`, err);
    }
  }

  // 2. Sandbox containers no live task claims.
  const liveTasks = await listTasks(db, { limit: 1000 }).catch(() => []);
  const claimedContainerIds = new Set(
    liveTasks
      .filter((t) => LIVE_STATUSES.includes(t.status))
      .map((t) => t.containerId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );

  let containers: { id: string; state: string; names: string[] }[] = [];
  try {
    containers = await ports.listSandboxContainers();
  } catch (err) {
    note('list sandbox containers', err);
  }

  for (const container of containers) {
    if (claimedContainerIds.has(container.id) || handledContainerIds.has(container.id)) {
      continue;
    }
    try {
      await ports.destroy({ containerId: container.id });
      report.removedContainerIds.push(container.id);
    } catch (err) {
      note(`remove orphan container ${container.id}`, err);
    }
  }

  // 3. Worktree directories no live task claims. The directory name is the task id.
  let dirs: string[] = [];
  try {
    dirs = await ports.listWorktreeDirs();
  } catch (err) {
    note('list worktree directories', err);
  }

  const root = worktreesRoot();
  for (const dir of dirs) {
    const fullPath = path.join(root, dir);
    if (report.removedWorktreePaths.includes(fullPath)) {
      continue;
    }
    let task;
    try {
      task = await getTask(db, dir);
    } catch (err) {
      note(`look up task for worktree ${dir}`, err);
      // Fail closed: an unknown task is not a licence to delete its worktree.
      continue;
    }
    if (task && LIVE_STATUSES.includes(task.status)) {
      continue;
    }
    try {
      await ports.removeDirectory(fullPath);
      report.removedWorktreePaths.push(fullPath);
    } catch (err) {
      note(`remove orphan worktree ${fullPath}`, err);
    }
  }

  // 4. Prune the worktree metadata left behind in each repo.
  const repos = await listRepos(db).catch((err) => {
    note('list repos', err);
    return [];
  });
  for (const repo of repos) {
    if (!repo.localPath || repo.localPath.trim().length === 0) {
      continue;
    }
    try {
      await ports.pruneWorktrees(repo.localPath);
      report.prunedRepoPaths.push(repo.localPath);
    } catch (err) {
      note(`prune worktrees in ${repo.localPath}`, err);
    }
  }

  return report;
}

/** Exported so a caller can see which statuses count as terminal without importing core. */
export const RECONCILE_TERMINAL_STATUSES = TERMINAL_STATUSES;
