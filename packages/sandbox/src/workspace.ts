import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
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
      await execa('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: resolvedRepo,
      });
    } catch {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
    }
  }

  // Clean up branch if already exists
  try {
    await execa('git', ['branch', '-D', branch], {
      cwd: resolvedRepo,
    });
  } catch {
    // Branch does not exist, ignore
  }

  // Add worktree on new branch
  await execa(
    'git',
    ['worktree', 'add', '-b', branch, worktreePath, baseBranch],
    {
      cwd: resolvedRepo,
    }
  );

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
    await execa('git', ['add', '-N', '.'], {
      cwd: workspace.worktreePath,
    });
  } catch {
    // Ignore if git add -N fails (e.g. no changes)
  }

  const { stdout } = await execa('git', ['diff', workspace.baseBranch], {
    cwd: workspace.worktreePath,
  });

  return stdout;
}
