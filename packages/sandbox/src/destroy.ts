import fs from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import { runGit } from './git.js';
import type { DestroyTarget, Workspace } from './types.js';

const docker = new Docker();

export async function destroy(
  target?: string | DestroyTarget,
  workspaceArg?: Workspace
): Promise<void> {
  let containerId: string | undefined;
  let workspace: Workspace | undefined;

  if (typeof target === 'string') {
    containerId = target;
    workspace = workspaceArg;
  } else if (target && typeof target === 'object') {
    if ('repoPath' in target && 'worktreePath' in target) {
      workspace = target as Workspace;
    } else {
      containerId = (target as DestroyTarget).containerId;
      workspace = (target as DestroyTarget).workspace ?? workspaceArg;
    }
  } else {
    workspace = workspaceArg;
  }

  // 1. Stop and remove container if provided
  if (containerId) {
    try {
      const container = docker.getContainer(containerId);
      try {
        await container.stop({ t: 2 });
      } catch {
        // Container may already be stopped
      }
      try {
        await container.remove({ force: true });
      } catch {
        // Container may already be removed
      }
    } catch {
      // Container not found or docker error
    }
  }

  // 2. Clean up git worktree and branch if provided
  if (workspace) {
    try {
      await runGit(workspace.repoPath, [
        'worktree',
        'remove',
        '--force',
        workspace.worktreePath,
      ]);
    } catch {
      // Worktree removal via git may fail if already unlinked
    }

    if (fs.existsSync(workspace.worktreePath)) {
      try {
        await fs.promises.rm(workspace.worktreePath, {
          recursive: true,
          force: true,
        });
      } catch {
        // Fallback cleanup
      }
    }

    // Clean up .git/worktrees/<taskId> in repo if still present
    const wtGitDir = path.join(
      workspace.repoPath,
      '.git',
      'worktrees',
      workspace.taskId
    );
    if (fs.existsSync(wtGitDir)) {
      try {
        await fs.promises.rm(wtGitDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }

    try {
      await runGit(workspace.repoPath, ['branch', '-D', workspace.branch]);
    } catch {
      // Branch may not exist
    }

    try {
      await runGit(workspace.repoPath, ['worktree', 'prune']);
    } catch {
      // Worktree prune best effort
    }
  }
}
