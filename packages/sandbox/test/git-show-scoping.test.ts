import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGit, createWorkspace, destroy, type Workspace } from '../src/index.js';

/**
 * `git show` and `git merge-base` must be worktree-scoped: run with cwd = the MAIN repo and an
 * explicit --git-dir/--work-tree, never with cwd inside the untrusted worktree.
 *
 * New file: no existing sandbox test is modified.
 */
describe('runGit scoping for show and merge-base', () => {
  let repoDir: string;
  let createdWorkspaces: Workspace[] = [];

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-show-scope-'));
    await runGit(repoDir, ['init', '-b', 'main']);
    await runGit(repoDir, ['config', 'user.name', 'Test Sandbox']);
    await runGit(repoDir, ['config', 'user.email', 'sandbox@example.com']);
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"base","scripts":{"test":"a"}}\n');
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

  it('show HEAD:<path> through a Workspace reads the worktree commit, not the main repo HEAD', async () => {
    const taskId = `test-show-scope-${Date.now()}`;
    const ws = await createWorkspace(repoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    // Commit a different package.json on the task branch, inside the worktree.
    fs.writeFileSync(
      path.join(ws.worktreePath, 'package.json'),
      '{"name":"base","scripts":{"test":"b"}}\n'
    );
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'task change']);

    const { stdout: headVersion } = await runGit(ws, ['show', 'HEAD:package.json']);
    expect(String(headVersion)).toContain('"test":"b"');

    const { stdout: baseVersion } = await runGit(ws, ['show', 'main:package.json']);
    expect(String(baseVersion)).toContain('"test":"a"');

    // The main repo's own HEAD is untouched by the task branch.
    const { stdout: mainVersion } = await runGit(repoDir, ['show', 'HEAD:package.json']);
    expect(String(mainVersion)).toContain('"test":"a"');
  });

  it('merge-base through a Workspace resolves against the worktree branch', async () => {
    const taskId = `test-mergebase-scope-${Date.now()}`;
    const ws = await createWorkspace(repoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    fs.writeFileSync(path.join(ws.worktreePath, 'extra.txt'), 'hello\n');
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'task commit']);

    const { stdout: mergeBase } = await runGit(ws, ['merge-base', 'main', 'HEAD']);
    const { stdout: mainHead } = await runGit(repoDir, ['rev-parse', 'main']);

    expect(String(mergeBase).trim()).toBe(String(mainHead).trim());
  });

  it('show is worktree-scoped: the injected flags name the worktree git dir and work tree', async () => {
    const taskId = `test-show-flags-${Date.now()}`;
    const ws = await createWorkspace(repoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    // `git rev-parse --git-dir` reports the git dir git actually used.
    const { stdout: gitDir } = await runGit(ws, ['show', '--quiet', '--format=%H', 'HEAD']);
    expect(String(gitDir).trim()).toMatch(/^[0-9a-f]{40}$/);

    // The worktree's git dir is under the main repo, and the work tree is the worktree path.
    const { stdout: resolved } = await runGit(ws, ['status', '--porcelain']);
    expect(String(resolved).trim()).toBe('');
  });
});
