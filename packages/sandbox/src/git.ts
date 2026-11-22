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

/**
 * Git global options that consume the NEXT argv entry as their value.
 *
 * This is the heart of F1: the value of `-c core.quotePath=false` does not start with '-',
 * so a naive "first argument that is not a flag" scan read it as the subcommand, matched
 * nothing in WORKTREE_SCOPED_COMMANDS, injected no --git-dir/--work-tree, and ran the
 * command against the MAIN REPO with exit code 0.
 */
const GIT_GLOBAL_FLAGS_TAKING_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/** Git global options that stand alone. */
const GIT_GLOBAL_FLAGS_STANDALONE = new Set([
  '--no-pager',
  '--paginate',
  '-P',
  '--bare',
  '--literal-pathspecs',
  '--no-literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-replace-objects',
  '--no-optional-locks',
]);

/**
 * Subcommands this harness is allowed to run. Anything else is a programming error and
 * must throw rather than fall through to an unscoped run.
 */
const KNOWN_GIT_SUBCOMMANDS = new Set([
  'add',
  'apply',
  'branch',
  'cat-file',
  'check-ignore',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'diff',
  'fetch',
  'for-each-ref',
  'init',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'mv',
  'push',
  'rebase',
  'remote',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'rm',
  'show',
  'show-ref',
  'stash',
  'status',
  'switch',
  'symbolic-ref',
  'tag',
  'worktree',
]);

/**
 * Locates the git subcommand, skipping global options and the values they consume.
 *
 * Throws when no known subcommand can be identified. Failing closed matters more than
 * convenience here: the alternative is an unscoped run against the main repo, which is
 * silent and looks like success.
 */
export function findSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (GIT_GLOBAL_FLAGS_TAKING_VALUE.has(arg)) {
      i++; // skip the value, which may look exactly like a subcommand
      continue;
    }
    // The `--flag=value` form carries its value inline.
    if (arg.startsWith('--') && arg.includes('=')) {
      const name = arg.slice(0, arg.indexOf('='));
      if (GIT_GLOBAL_FLAGS_TAKING_VALUE.has(name)) continue;
    }
    if (GIT_GLOBAL_FLAGS_STANDALONE.has(arg)) continue;
    if (arg.startsWith('-')) continue;

    if (KNOWN_GIT_SUBCOMMANDS.has(arg)) return arg;

    throw new Error(
      `runGit: could not identify a git subcommand (got ${JSON.stringify(arg)} in ` +
        `${JSON.stringify(args)}). Refusing to run unscoped.`
    );
  }

  throw new Error(
    `runGit: could not identify a git subcommand in ${JSON.stringify(args)}. ` +
      'Refusing to run unscoped.'
  );
}

export const WORKTREE_SCOPED_COMMANDS = new Set([
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
export function buildGitArgs(
  workspaceOrRepo: Workspace | string,
  args: readonly string[]
): { finalArgs: string[]; repoPath: string; subCommand: string; scoped: boolean } {
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

  // Throws on anything unparseable, for either target, so a bad call never runs at all.
  const subCommand = findSubcommand(args);

  let scopedFlags: string[] = [];
  let scoped = false;
  if (isWorkspace(workspaceOrRepo) && WORKTREE_SCOPED_COMMANDS.has(subCommand)) {
    const worktreeGitDir = getWorktreeGitDir(repoPath, workspaceOrRepo.taskId);
    scopedFlags = [
      `--git-dir=${worktreeGitDir}`,
      `--work-tree=${workspaceOrRepo.worktreePath}`,
    ];
    scoped = true;
  }

  return { finalArgs: [...baseFlags, ...scopedFlags, ...args], repoPath, subCommand, scoped };
}

export async function runGit(
  workspaceOrRepo: Workspace | string,
  args: string[],
  opts?: ExecaOptions
): Promise<ExecaResult> {
  const { finalArgs, repoPath } = buildGitArgs(workspaceOrRepo, args);

  return execa('git', finalArgs, {
    ...opts,
    cwd: repoPath,
  });
}
