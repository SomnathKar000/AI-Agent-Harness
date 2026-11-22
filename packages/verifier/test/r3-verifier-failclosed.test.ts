import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Repo, Task } from '@harness/core';
import type { Database } from '@harness/db';
import { runGit, createWorkspace, destroy, type Workspace } from '@harness/sandbox';
import { verifyTask, evaluateDiffPolicy, type VerifierSandbox } from '../src/index.js';

/**
 * Round 3: items 2 (the commit is what is verified) and 3 (everything fails closed).
 * New file: no existing test is modified.
 */
describe('verifyTask round 3 fail-closed behavior', { timeout: 30000 }, () => {
  let tempRepoDir: string;
  let createdWorkspaces: Workspace[] = [];

  const passingExec = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });

  const fullRepo: Repo = {
    id: 'repo-1',
    name: 'r3-repo',
    localPath: '',
    defaultBranch: 'main',
    lintCommand: 'echo lint',
    typecheckCommand: 'echo typecheck',
    testCommand: 'echo test',
  };

  const makeTask = (id: string): Task => ({
    id,
    repoId: 'repo-1',
    type: 'bugfix',
    title: 'r3',
    description: 'round 3 fail-closed',
    status: 'verifying',
    attempt: 1,
    maxSteps: 10,
    maxCostUsd: 1,
    maxMinutes: 5,
  });

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-r3-fc-'));
    await runGit(tempRepoDir, ['init', '-b', 'main']);
    await runGit(tempRepoDir, ['config', 'user.name', 'Test Verifier']);
    await runGit(tempRepoDir, ['config', 'user.email', 'verifier@example.com']);

    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify({ name: 'r3', version: '1.0.0', scripts: { test: 'vitest run' } }, null, 2)
    );
    fs.mkdirSync(path.join(tempRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRepoDir, 'src', 'calc.ts'), 'export const calc = () => 2;\n');
    fs.mkdirSync(path.join(tempRepoDir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, 'test', 'calc.test.ts'),
      "import { expect } from 'vitest';\nexpect(2).toBe(2);\n"
    );
    fs.writeFileSync(path.join(tempRepoDir, '.gitignore'), '.env\nnode_modules\n');
    await runGit(tempRepoDir, ['add', '-A']);
    await runGit(tempRepoDir, ['commit', '-m', 'initial commit']);
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
      const wtList = await runGit(tempRepoDir, ['worktree', 'list']);
      expect(wtList.stdout.trim().split('\n').length).toBe(1);
      const branchList = await runGit(tempRepoDir, ['branch', '--list', 'harness/*']);
      expect(branchList.stdout.trim()).toBe('');
    } catch {
      // repo already removed
    }
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const makeWorkspace = async (taskId: string): Promise<Workspace> => {
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);
    return ws;
  };

  // ---------------------------------------------------------------- item 2
  describe('Item 2: the committed diff is what gets verified', () => {
    it('a committed test deletion restored in the working tree still fails', async () => {
      const ws = await makeWorkspace(`task-r3-del-${Date.now()}`);

      // `rm` is not worktree-scoped in runGit, so delete on disk and stage with `add -A`.
      fs.rmSync(path.join(ws.worktreePath, 'test', 'calc.test.ts'));
      await runGit(ws, ['add', '-A']);
      await runGit(ws, ['commit', '-m', 'delete the test']);

      // Put the file back on disk so the working tree "looks" innocent.
      fs.writeFileSync(
        path.join(ws.worktreePath, 'test', 'calc.test.ts'),
        "import { expect } from 'vitest';\nexpect(2).toBe(2);\n"
      );

      const result = await evaluateDiffPolicy(ws, 'main');

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('test_file_deleted'))).toBe(true);
    });

    it('an uncommitted change fails the named worktree_clean check', async () => {
      const ws = await makeWorkspace(`task-r3-dirty-${Date.now()}`);
      fs.writeFileSync(path.join(ws.worktreePath, 'src', 'calc.ts'), 'export const calc = () => 3;\n');

      const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: passingExec };
      const result = await verifyTask(makeTask('t-dirty'), sandbox, {
        repo: { ...fullRepo, localPath: tempRepoDir },
      });

      const check = result.checks.find((c) => c.name === 'worktree_clean');
      expect(check).toBeDefined();
      expect(check?.passed).toBe(false);
      expect(check?.rule).toBe('worktree_dirty');
      expect(result.passed).toBe(false);
    });

    it('an untracked file also fails worktree_clean', async () => {
      const ws = await makeWorkspace(`task-r3-untracked-${Date.now()}`);
      fs.writeFileSync(path.join(ws.worktreePath, 'stray.txt'), 'stray\n');

      const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: passingExec };
      const result = await verifyTask(makeTask('t-untracked'), sandbox, {
        repo: { ...fullRepo, localPath: tempRepoDir },
      });

      expect(result.checks.find((c) => c.name === 'worktree_clean')?.passed).toBe(false);
    });

    it('a committed package.json scripts change reverted on disk still fails', async () => {
      const ws = await makeWorkspace(`task-r3-scripts-${Date.now()}`);

      const original = fs.readFileSync(path.join(ws.worktreePath, 'package.json'), 'utf8');
      fs.writeFileSync(
        path.join(ws.worktreePath, 'package.json'),
        JSON.stringify({ name: 'r3', version: '1.0.0', scripts: { test: 'exit 0' } }, null, 2)
      );
      await runGit(ws, ['add', '-A']);
      await runGit(ws, ['commit', '-m', 'weaken the test script']);

      // Revert on disk only: the commit still carries the change.
      fs.writeFileSync(path.join(ws.worktreePath, 'package.json'), original);

      const result = await evaluateDiffPolicy(ws, 'main');

      expect(result.violations.some((v) => v.includes('package_scripts_modified'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------- item 3
  describe('Item 3: missing commands and failed lookups are failures, never skips', () => {
    for (const missing of ['lintCommand', 'typecheckCommand', 'testCommand'] as const) {
      it(`a missing ${missing} is a failed check with rule command_not_configured`, async () => {
        const ws = await makeWorkspace(`task-r3-${missing}-${Date.now()}`);
        const repo: Repo = { ...fullRepo, localPath: tempRepoDir, [missing]: undefined };

        const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: passingExec };
        const result = await verifyTask(makeTask(`t-${missing}`), sandbox, { repo });

        const checkName = missing.replace('Command', '');
        const check = result.checks.find((c) => c.name === checkName);
        expect(check?.passed).toBe(false);
        expect(check?.rule).toBe('command_not_configured');
        expect(result.passed).toBe(false);
      });
    }

    it('an empty-string command is also command_not_configured', async () => {
      const ws = await makeWorkspace(`task-r3-empty-${Date.now()}`);
      const repo: Repo = { ...fullRepo, localPath: tempRepoDir, lintCommand: '   ' };

      const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: passingExec };
      const result = await verifyTask(makeTask('t-empty'), sandbox, { repo });

      expect(result.checks.find((c) => c.name === 'lint')?.rule).toBe('command_not_configured');
      expect(result.passed).toBe(false);
    });

    it('a repo lookup that throws returns a failure naming the reason, not passed:true', async () => {
      const ws = await makeWorkspace(`task-r3-dberr-${Date.now()}`);
      const throwingDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.reject(new Error('connection reset by peer')),
          }),
        }),
      } as unknown as Database;

      const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: passingExec };
      const result = await verifyTask(makeTask('t-dberr'), sandbox, { db: throwingDb });

      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.rule === 'repo_lookup_failed')).toBe(true);
      expect(result.checks.some((c) => c.output?.includes('connection reset by peer'))).toBe(true);
    });

    it('an approvals lookup that throws is a failure, not a silent empty approval set', async () => {
      const ws = await makeWorkspace(`task-r3-apperr-${Date.now()}`);
      const throwingDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.reject(new Error('approvals table unavailable')),
          }),
        }),
      } as unknown as Database;

      const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: passingExec };
      const result = await verifyTask(makeTask('t-apperr'), sandbox, {
        db: throwingDb,
        repo: { ...fullRepo, localPath: tempRepoDir },
      });

      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.rule === 'approval_lookup_failed')).toBe(true);
    });

    it('a missing base branch is a failed check, not a silent default to main', async () => {
      const ws = await makeWorkspace(`task-r3-nobase-${Date.now()}`);
      const noBase = { ...ws, baseBranch: '' } as Workspace;

      const sandbox: VerifierSandbox = {
        workspace: noBase,
        containerId: 'fake-c',
        exec: passingExec,
      };
      const result = await verifyTask(makeTask('t-nobase'), sandbox, {
        repo: { ...fullRepo, localPath: tempRepoDir },
      });

      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.rule === 'base_branch_not_configured')).toBe(true);
    });

    it('a result with no checks at all is never passed:true', async () => {
      const ws = await makeWorkspace(`task-r3-nochecks-${Date.now()}`);
      // An unresolvable repo yields exactly one failed check, never an empty passing report.
      const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: passingExec };
      const result = await verifyTask(
        { id: 't-nochecks', repoId: undefined } as never,
        sandbox,
        {}
      );

      expect(result.passed).toBe(false);
      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.checks.every((c) => c.passed)).toBe(false);
    });
  });
});
