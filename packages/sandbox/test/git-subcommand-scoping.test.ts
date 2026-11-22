import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGit, createWorkspace, destroy, type Workspace } from '../src/index.js';

/**
 * F1: runGit located the subcommand with args.find((a) => !a.startsWith('-')).
 *
 * The VALUE of a `-c key=value` pair does not start with '-', so it was read as the
 * subcommand. Nothing matched WORKTREE_SCOPED_COMMANDS, no --git-dir/--work-tree was
 * injected, and the command ran against the MAIN REPO with exit code 0 — the Phase 1
 * containment guarantee failing silently.
 *
 * These tests use only runGit, so they fail on behaviour rather than on a missing export.
 */
describe('runGit subcommand resolution and worktree scoping', { timeout: 60000 }, () => {
  let repoDir: string;
  let createdWorkspaces: Workspace[] = [];

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-subcmd-'));
    await runGit(repoDir, ['init', '-b', 'main']);
    await runGit(repoDir, ['config', 'user.name', 'Test Sandbox']);
    await runGit(repoDir, ['config', 'user.email', 'sandbox@example.com']);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    await runGit(repoDir, ['add', '-A']);
    await runGit(repoDir, ['commit', '-m', 'base commit']);
  });

  afterEach(async () => {
    for (const ws of createdWorkspaces) {
      try {
        await destroy(undefined, ws);
      } catch {
        // best effort
      }
    }
    createdWorkspaces = [];
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  /** A worktree holding one commit that does not exist in the main repo. */
  async function worktreeWithOwnCommit(name: string): Promise<Workspace> {
    const ws = await createWorkspace(repoDir, `${name}-${Date.now()}`, 'main');
    createdWorkspaces.push(ws);
    fs.writeFileSync(path.join(ws.worktreePath, 'only-in-worktree.txt'), 'task work\n');
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'commit that exists only in the worktree']);
    return ws;
  }

  it('a leading -c pair does not stop the diff being scoped to the worktree', async () => {
    const ws = await worktreeWithOwnCommit('cflag');

    const { stdout } = await runGit(ws, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-status',
      'main',
    ]);

    // Scoped: the worktree's own commit is visible. Unscoped (main repo): empty.
    expect(String(stdout)).toContain('only-in-worktree.txt');
  });

  it('a -c VALUE that looks like a subcommand is still parsed as a diff and still scoped', async () => {
    const ws = await worktreeWithOwnCommit('cfoo');

    // A well-formed config key (git requires section.key) whose VALUE is a real subcommand.
    const { stdout } = await runGit(ws, ['-c', 'foo.bar=status', 'diff', '--name-status', 'main']);

    // A `status` run would print porcelain-ish output, not a name-status diff line.
    expect(String(stdout)).toContain('only-in-worktree.txt');
    expect(String(stdout)).toMatch(/^[AMD]\s/m);
  });

  it('--no-pager before the subcommand keeps the diff scoped', async () => {
    const ws = await worktreeWithOwnCommit('nopager');

    const { stdout } = await runGit(ws, ['--no-pager', 'diff', '--name-status', 'main']);

    expect(String(stdout)).toContain('only-in-worktree.txt');
  });

  it('-C <path> before the subcommand resolves to that subcommand and stays scoped', async () => {
    const ws = await worktreeWithOwnCommit('cupper');

    // Unparsed, `/tmp` is read as the subcommand, nothing is scoped, and git runs in /tmp.
    const { stdout } = await runGit(ws, ['-C', os.tmpdir(), 'status', '--porcelain']);

    // The scoped worktree is clean, so status is empty rather than an error.
    expect(String(stdout).trim()).toBe('');
  });

  it('an unrecognisable subcommand throws instead of running unscoped', async () => {
    const ws = await worktreeWithOwnCommit('unknown');

    await expect(runGit(ws, ['-c', 'a=b', '--definitely-not-a-flag-value'])).rejects.toThrow(
      /could not identify a git subcommand/i
    );
  });

  it('an empty argument list throws rather than invoking git bare', async () => {
    const ws = await worktreeWithOwnCommit('empty');

    await expect(runGit(ws, [])).rejects.toThrow(/could not identify a git subcommand/i);
  });
});
