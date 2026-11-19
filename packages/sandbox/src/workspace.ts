import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGit } from './git.js';
import type { Workspace } from './types.js';

export async function createWorkspace(
  repoPath: string,
  taskId: string,
  baseBranch: string
): Promise<Workspace> {
  const resolvedRepo = path.resolve(repoPath);
  const worktreesDir = path.join(os.homedir(), '.harness', 'worktrees');
  await fs.promises.mkdir(worktreesDir, { recursive: true });

  const worktreePath = path.join(worktreesDir, taskId);
  const branch = `harness/${taskId}`;

  // Clean up existing worktree at this path if leftover
  if (fs.existsSync(worktreePath)) {
    try {
      await runGit(resolvedRepo, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
    }
  }

  // Clean up branch if already exists
  try {
    await runGit(resolvedRepo, ['branch', '-D', branch]);
  } catch {
    // Branch does not exist, ignore
  }

  // Add worktree on new branch
  await runGit(resolvedRepo, [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    baseBranch,
  ]);

  return {
    taskId,
    repoPath: resolvedRepo,
    worktreePath,
    branch,
    baseBranch,
  };
}

export async function getDiff(workspace: Workspace): Promise<string> {
  // Track intent to add for any untracked files so they show in diff
  try {
    await runGit(workspace, ['add', '-N', '.']);
  } catch {
    // Ignore if git add -N fails (e.g. no changes)
  }

  const { stdout } = await runGit(workspace, ['diff', workspace.baseBranch]);

  return String(stdout ?? '');
}
