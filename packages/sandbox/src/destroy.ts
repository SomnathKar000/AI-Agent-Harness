import fs from 'node:fs';
import Docker from 'dockerode';
import { execa } from 'execa';
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
    containerId = target.containerId;
    workspace = target.workspace ?? workspaceArg;
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
      await execa('git', ['worktree', 'remove', '--force', workspace.worktreePath], {
        cwd: workspace.repoPath,
      });
    } catch {
      // Worktree removal via git may fail if already unlinked
    }

    if (fs.existsSync(workspace.worktreePath)) {
      try {
        await fs.promises.rm(workspace.worktreePath, { recursive: true, force: true });
      } catch {
        // Fallback cleanup
      }
    }

    try {
      await execa('git', ['branch', '-D', workspace.branch], {
        cwd: workspace.repoPath,
      });
    } catch {
      // Branch may not exist
    }

    try {
      await execa('git', ['worktree', 'prune'], {
        cwd: workspace.repoPath,
      });
    } catch {
      // Worktree prune best effort
    }
  }
}
