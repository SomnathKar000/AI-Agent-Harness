import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  findSubcommand,
  buildGitArgs,
  WORKTREE_SCOPED_COMMANDS,
  type Workspace,
} from '../src/index.js';

/**
 * Guard on the resolved argv itself, so scoping is asserted directly rather than inferred
 * from a command's output.
 */
describe('git argv guard', () => {
  const ws: Workspace = {
    taskId: 'guard-task',
    repoPath: path.join(os.tmpdir(), 'guard-main-repo'),
    worktreePath: path.join(os.tmpdir(), 'guard-worktree'),
    baseBranch: 'main',
    branchName: 'harness/guard-task',
  } as Workspace;

  it('every worktree-scoped subcommand receives both --git-dir and --work-tree', () => {
    expect(WORKTREE_SCOPED_COMMANDS.size).toBeGreaterThan(0);

    for (const subCommand of WORKTREE_SCOPED_COMMANDS) {
      const { finalArgs, scoped } = buildGitArgs(ws, [subCommand]);

      expect(scoped, `${subCommand} must be scoped`).toBe(true);
      expect(
        finalArgs.some((a) => a.startsWith('--git-dir=')),
        `${subCommand} is missing --git-dir`
      ).toBe(true);
      expect(
        finalArgs.some((a) => a.startsWith('--work-tree=')),
        `${subCommand} is missing --work-tree`
      ).toBe(true);
      expect(
        finalArgs.some((a) => a.includes(ws.worktreePath)),
        `${subCommand} does not name the worktree path`
      ).toBe(true);
    }
  });

  it('scoping survives global options placed before the subcommand', () => {
    for (const prefix of [
      ['-c', 'core.quotePath=false'],
      ['-c', 'foo=status'],
      ['-C', os.tmpdir()],
      ['--no-pager'],
      ['--literal-pathspecs'],
      ['--namespace', 'ns'],
      ['--config-env', 'KEY=ENVVAR'],
      ['--git-dir=/somewhere/else'],
    ]) {
      const { finalArgs, subCommand, scoped } = buildGitArgs(ws, [...prefix, 'diff', 'main']);

      expect(subCommand, `prefix ${prefix.join(' ')}`).toBe('diff');
      expect(scoped, `prefix ${prefix.join(' ')}`).toBe(true);
      expect(finalArgs.some((a) => a.startsWith('--work-tree='))).toBe(true);
      // Our scoping flags precede the caller's args, so an absolute --git-dir wins.
      const ourGitDir = finalArgs.findIndex((a) => a.startsWith('--git-dir=') && a.includes('guard-task'));
      expect(ourGitDir).toBeGreaterThan(-1);
    }
  });

  it('a string repo target is never given worktree flags', () => {
    const { finalArgs, scoped } = buildGitArgs(os.tmpdir(), ['diff', 'main']);
    expect(scoped).toBe(false);
    expect(finalArgs.some((a) => a.startsWith('--git-dir='))).toBe(false);
    expect(finalArgs.some((a) => a.startsWith('--work-tree='))).toBe(false);
  });

  describe('findSubcommand', () => {
    it('skips global options and the values they consume', () => {
      expect(findSubcommand(['-c', 'core.quotePath=false', 'diff'])).toBe('diff');
      expect(findSubcommand(['-c', 'foo=status', 'diff'])).toBe('diff');
      expect(findSubcommand(['-c', 'a=b', '-c', 'c=d', 'show', 'HEAD:x'])).toBe('show');
      expect(findSubcommand(['-C', '/tmp', 'status'])).toBe('status');
      expect(findSubcommand(['--no-pager', 'diff', 'main'])).toBe('diff');
      expect(findSubcommand(['-P', 'log'])).toBe('log');
      expect(findSubcommand(['--git-dir', '/x/.git', 'status'])).toBe('status');
      expect(findSubcommand(['--git-dir=/x/.git', 'status'])).toBe('status');
      expect(findSubcommand(['--work-tree', '/x', 'add', '-A'])).toBe('add');
      expect(findSubcommand(['--namespace', 'ns', 'branch'])).toBe('branch');
      expect(findSubcommand(['--config-env', 'KEY=VAR', 'commit', '-m', 'x'])).toBe('commit');
      expect(findSubcommand(['--literal-pathspecs', 'rm', 'f'])).toBe('rm');
      expect(findSubcommand(['worktree', 'list'])).toBe('worktree');
    });

    it('never mistakes a -c value for the subcommand even when it is a real one', () => {
      // Every scoped subcommand, smuggled in as a -c value.
      for (const name of WORKTREE_SCOPED_COMMANDS) {
        expect(findSubcommand(['-c', `foo=${name}`, 'merge-base', 'main', 'HEAD'])).toBe(
          'merge-base'
        );
      }
    });

    it('throws on an unknown subcommand rather than returning it', () => {
      expect(() => findSubcommand(['definitely-not-a-subcommand'])).toThrow(
        /could not identify a git subcommand/i
      );
      expect(() => findSubcommand(['-c', 'a=b', 'nope'])).toThrow(
        /could not identify a git subcommand/i
      );
    });

    it('throws when there is no subcommand at all', () => {
      expect(() => findSubcommand([])).toThrow(/could not identify a git subcommand/i);
      expect(() => findSubcommand(['--no-pager'])).toThrow(/could not identify a git subcommand/i);
      expect(() => findSubcommand(['-c', 'a=b'])).toThrow(/could not identify a git subcommand/i);
    });
  });
});
