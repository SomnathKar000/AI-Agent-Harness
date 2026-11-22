import fs from 'node:fs';
import path from 'node:path';
import { execa, type Options as ExecaOptions, type Result as ExecaResult } from 'execa';
import type { Workspace } from './types.js';

function isWorkspace(target: Workspace | string): target is Workspace {
  return (
    typeof target === 'object' &&
    target !== null &&
    'worktreePath' in target &&
    'taskId' in target &&
    'repoPath' in target
  );
}

function getWorktreeGitDir(repoPath: string, taskId: string): string {
  const mainGit = path.join(repoPath, '.git');
  if (fs.existsSync(mainGit) && fs.statSync(mainGit).isDirectory()) {
    return path.join(mainGit, 'worktrees', taskId);
  }
  if (fs.existsSync(mainGit) && fs.statSync(mainGit).isFile()) {
    const content = fs.readFileSync(mainGit, 'utf8');
    const match = content.match(/gitdir:\s*(.+)/);
    if (match) {
      const gitDir = path.resolve(repoPath, match[1].trim());
      return path.join(gitDir, 'worktrees', taskId);
    }
  }
  return path.join(repoPath, '.git', 'worktrees', taskId);
}

const WORKTREE_SCOPED_COMMANDS = new Set([
  'diff',
  'add',
  'status',
  'commit',
  'reset',
  'checkout',
  'restore',
  // 'show' and 'merge-base' resolve revisions (HEAD, <merge-base>:<path>) that only mean the
  // right thing in the task's worktree. Scoping them here keeps cwd = main repo with an
  // explicit --git-dir/--work-tree, instead of callers passing the worktree path as a string
  // and running git inside untrusted content.
  'show',
  'merge-base',
]);

/**
 * Single entry point for all host-side git operations in @harness/sandbox.
 * Always runs with cwd = main repo path (never worktree path) and always injects security flags.
 * Injects explicit --git-dir and --work-tree for worktree-scoped operations.
 */
export async function runGit(
  workspaceOrRepo: Workspace | string,
  args: string[],
  opts?: ExecaOptions
): Promise<ExecaResult> {
  const repoPath = isWorkspace(workspaceOrRepo)
    ? workspaceOrRepo.repoPath
    : path.resolve(workspaceOrRepo);

  const baseFlags = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.sshCommand=/bin/false',
    '-c',
    'protocol.ext.allow=never',
  ];

  let scopedFlags: string[] = [];
  if (isWorkspace(workspaceOrRepo)) {
    const subCommand = args.find((arg) => !arg.startsWith('-'));
    if (subCommand && WORKTREE_SCOPED_COMMANDS.has(subCommand)) {
      const worktreeGitDir = getWorktreeGitDir(repoPath, workspaceOrRepo.taskId);
      scopedFlags = [
        `--git-dir=${worktreeGitDir}`,
        `--work-tree=${workspaceOrRepo.worktreePath}`,
      ];
    }
  }

  const finalArgs = [...baseFlags, ...scopedFlags, ...args];

  return execa('git', finalArgs, {
    ...opts,
    cwd: repoPath,
  });
}
