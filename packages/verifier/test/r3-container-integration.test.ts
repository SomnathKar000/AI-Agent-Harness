import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Repo, Task } from '@harness/core';
import { runGit, createWorkspace, startContainer, destroy, type Workspace } from '@harness/sandbox';
import { verifyTask, type VerifierSandbox } from '../src/index.js';

/**
 * Round 3, item 11: one Docker integration test that exercises the REAL sandbox exec path.
 * No `exec` is injected here, so packages/sandbox's exec() is what runs the commands.
 *
 * It uses fixtures/buggy-repo as it stands and never mutates it: all work happens in a
 * git worktree, which is destroyed in afterEach. `pnpm fixtures:setup` is deliberately NOT
 * run, because it would rm -rf the fixtures and move their heads.
 *
 * The fixture's real bug is `startIndex = page * pageSize` instead of `(page - 1) * pageSize`.
 * Node 22 in the sandbox image strips types, so the bug is exercised directly without
 * installing vitest — the container has no network at runtime.
 */
const BUGGY_REPO_PATH = path.resolve(import.meta.dirname, '../../../fixtures/buggy-repo');

const PAGINATE_CHECK = [
  'cd /workspace &&',
  'node --input-type=module --experimental-strip-types --eval',
  '"const m = await import(\'/workspace/src/paginate.ts\');',
  "const r = m.paginate(['a','b','c','d','e','f','g'], 1, 3);",
  "console.log('cwd=' + process.cwd());",
  "console.log('items=' + JSON.stringify(r.items));",
  "if (JSON.stringify(r.items) !== JSON.stringify(['a','b','c'])) { process.exit(1); }",
  'console.log(\'paginate ok\');"',
].join(' ');

describe('Real container verification against the buggy fixture', { timeout: 180000 }, () => {
  let createdWorkspaces: Workspace[] = [];
  let createdContainers: string[] = [];

  afterEach(async () => {
    for (const containerId of createdContainers) {
      try {
        await destroy(containerId);
      } catch {
        // best effort
      }
    }
    createdContainers = [];
    for (const ws of createdWorkspaces) {
      try {
        await destroy(undefined, ws);
      } catch {
        // best effort
      }
    }
    createdWorkspaces = [];

    // The fixture must be left exactly as it was found.
    const wtList = await runGit(BUGGY_REPO_PATH, ['worktree', 'list']);
    expect(wtList.stdout.trim().split('\n').length).toBe(1);
    const branchList = await runGit(BUGGY_REPO_PATH, ['branch', '--list', 'harness/*']);
    expect(branchList.stdout.trim()).toBe('');
    const status = await runGit(BUGGY_REPO_PATH, ['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
  });

  it('runs the checks in the container: the buggy fixture fails, and the committed fix passes', async () => {
    const taskId = `test-r3-container-${Date.now()}`;
    const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
    createdWorkspaces.push(ws);

    const containerId = await startContainer(ws);
    createdContainers.push(containerId);

    // No `exec` injected: this goes through packages/sandbox exec().
    const sandbox: VerifierSandbox = { workspace: ws, containerId };

    const repo: Repo = {
      id: 'repo-buggy',
      name: 'pagination-repo',
      localPath: BUGGY_REPO_PATH,
      defaultBranch: 'main',
      lintCommand: 'node --version',
      typecheckCommand: 'test -f /workspace/package.json',
      testCommand: PAGINATE_CHECK,
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'pagination off-by-one',
      description: 'paginate skips the first page',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    // ---- before the fix: the test check must fail -------------------------------------
    const before = await verifyTask(task, sandbox, { repo });

    const testCheckBefore = before.checks.find((c) => c.name === 'test');
    expect(testCheckBefore?.passed).toBe(false);
    expect(before.passed).toBe(false);

    // The command ran in the container, not on the host.
    const outputBefore = before.checks.map((c) => c.output ?? '').join('\n');
    expect(outputBefore).toContain('cwd=/workspace');
    expect(outputBefore).toContain("items=[\"d\",\"e\",\"f\"]");
    // The host path of the worktree and the home directory must never appear.
    expect(outputBefore).not.toContain(BUGGY_REPO_PATH);
    expect(outputBefore).not.toContain(ws.worktreePath);
    expect(outputBefore).not.toContain(os.homedir());

    // ---- commit the real fix in the worktree ------------------------------------------
    const sourcePath = path.join(ws.worktreePath, 'src', 'paginate.ts');
    const buggy = fs.readFileSync(sourcePath, 'utf8');
    expect(buggy).toContain('const startIndex = page * pageSize;');
    fs.writeFileSync(
      sourcePath,
      buggy.replace(
        'const startIndex = page * pageSize;',
        'const startIndex = (page - 1) * pageSize;'
      )
    );
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'fix: paginate off-by-one on startIndex']);

    // ---- after the fix: every check passes ---------------------------------------------
    const after = await verifyTask(task, sandbox, { repo });

    const testCheckAfter = after.checks.find((c) => c.name === 'test');
    expect(testCheckAfter?.passed).toBe(true);
    expect(after.checks.find((c) => c.name === 'worktree_clean')?.passed).toBe(true);
    expect(after.checks.find((c) => c.name === 'diff_policy')?.passed).toBe(true);
    expect(after.passed).toBe(true);

    const outputAfter = after.checks.map((c) => c.output ?? '').join('\n');
    expect(outputAfter).toContain('paginate ok');
    expect(outputAfter).not.toContain(ws.worktreePath);
  });
});
