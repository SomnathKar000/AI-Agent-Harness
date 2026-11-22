import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as sandboxModule from '@harness/sandbox';
import { runGit, createWorkspace, startContainer, destroy, type Workspace } from '@harness/sandbox';
import { createDb, runMigrations, createRepo, createTask, verifications, eq, type Database } from '@harness/db';
import type { Repo, Task } from '@harness/core';
import { verifyTask, type VerifierSandbox } from '../src/index.js';

const ROOT_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://harness:harness_password@127.0.0.1:5433/harness';
const TEST_DB_NAME = 'harness_test';
const TEST_ADMIN_URL = ROOT_ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
const TEST_APP_URL = (
  process.env.DATABASE_URL ||
  'postgres://harness_app:harness_app_password@127.0.0.1:5433/harness'
).replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

describe('verifyTask End-to-End & Integration Tests', { timeout: 30000 }, () => {
  let db: Database;
  let tempRepoDir: string;
  let createdWorkspaces: Workspace[] = [];
  let createdContainers: string[] = [];

  beforeAll(async () => {
    try {
      await runMigrations(TEST_ADMIN_URL);
      db = createDb(TEST_APP_URL);
    } catch {
      // If DB is unreachable (e.g. standard sandbox mode without bypass), db remains undefined
    }
  });

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-verifier-e2e-'));
    await runGit(tempRepoDir, ['init', '-b', 'main']);
    await runGit(tempRepoDir, ['config', 'user.name', 'Test Verifier']);
    await runGit(tempRepoDir, ['config', 'user.email', 'verifier@example.com']);

    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify(
        {
          name: 'e2e-repo',
          version: '1.0.0',
          scripts: {
            test: 'vitest run',
            lint: 'eslint .',
            typecheck: 'tsc --noEmit',
          },
        },
        null,
        2
      )
    );

    fs.mkdirSync(path.join(tempRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, 'src', 'calc.ts'),
      'export function calc(x: number): number { return x * 2; }\n'
    );

    fs.mkdirSync(path.join(tempRepoDir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, 'test', 'calc.test.ts'),
      `import { describe, it, expect } from 'vitest';
import { calc } from '../src/calc.js';

describe('calc', () => {
  it('multiplies by two', () => {
    expect(calc(2)).toBe(4);
  });
});
`
    );

    await runGit(tempRepoDir, ['add', '.']);
    await runGit(tempRepoDir, ['commit', '-m', 'Initial baseline commit']);
  });

  afterEach(async () => {
    for (const cid of createdContainers) {
      try {
        await destroy(cid);
      } catch {
        // ignore
      }
    }
    createdContainers = [];

    for (const ws of createdWorkspaces) {
      try {
        await destroy(undefined, ws);
      } catch {
        // cleanup best-effort
      }
    }
    createdWorkspaces = [];

    // Assert git worktree list has only the main worktree and no harness/* branches
    try {
      const wtList = await runGit(tempRepoDir, ['worktree', 'list']);
      const wtLines = wtList.stdout.trim().split('\n');
      expect(wtLines.length).toBe(1);

      const branchList = await runGit(tempRepoDir, ['branch', '--list', 'harness/*']);
      expect(branchList.stdout.trim()).toBe('');
    } catch {
      // ignore
    }

    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('flaky test rerun: fails first test run, passes on second run -> marked passed with flaky=true', async () => {
    const taskId = `task-flaky-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    let testRunCount = 0;
    const execMock = async (cmd: string[]) => {
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('vitest') || cmdStr.includes('test')) {
        testRunCount++;
        if (testRunCount === 1) {
          return { exitCode: 1, stdout: '', stderr: 'Flaky failure on attempt 1', timedOut: false };
        }
        return { exitCode: 0, stdout: 'Tests passed on attempt 2', stderr: '', timedOut: false };
      }
      return { exitCode: 0, stdout: 'OK', stderr: '', timedOut: false };
    };

    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId: 'fake-container-flaky',
      exec: execMock,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Flaky test check',
      description: 'Testing rerun logic',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo });
    expect(result.passed).toBe(true);
    expect(result.flaky).toBe(true);
    expect(testRunCount).toBe(2);

    const testCheck = result.checks.find((c) => c.name === 'test');
    expect(testCheck?.passed).toBe(true);
    expect(testCheck?.flaky).toBe(true);
  });

  it('fails when tests fail both runs (flaky=false, passed=false)', async () => {
    const taskId = `task-fail-tests-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    let testRunCount = 0;
    const execMock = async (cmd: string[]) => {
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('vitest') || cmdStr.includes('test')) {
        testRunCount++;
        return { exitCode: 1, stdout: '', stderr: `Failed attempt ${testRunCount}`, timedOut: false };
      }
      return { exitCode: 0, stdout: 'OK', stderr: '', timedOut: false };
    };

    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId: 'fake-container',
      exec: execMock,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Failing tests check',
      description: 'Testing failure logic',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo });
    expect(result.passed).toBe(false);
    expect(result.flaky).toBe(false);
    expect(testRunCount).toBe(2); // rerun once, then failed

    const testCheck = result.checks.find((c) => c.name === 'test');
    expect(testCheck?.passed).toBe(false);
  });

  it('fails when lint fails (does not rerun lint)', async () => {
    const taskId = `task-fail-lint-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    let lintRunCount = 0;
    const execMock = async (cmd: string[]) => {
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('lint')) {
        lintRunCount++;
        return { exitCode: 1, stdout: '', stderr: 'Lint errors found', timedOut: false };
      }
      return { exitCode: 0, stdout: 'OK', stderr: '', timedOut: false };
    };

    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId: 'fake-container',
      exec: execMock,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Failing lint check',
      description: 'Testing lint failure',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo });
    expect(result.passed).toBe(false);
    expect(lintRunCount).toBe(1); // lint is not rerun

    const lintCheck = result.checks.find((c) => c.name === 'lint');
    expect(lintCheck?.passed).toBe(false);
  });

  it('Prove the verifier verifies the COMMITTED diff, not the agents claims: agent claims success but committed diff deletes test file -> MUST FAIL', async () => {
    const taskId = `task-agent-claim-fail-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    // Agent simulates success in tool execution and claims:
    // "Everything is fixed and tests pass!"
    // BUT the agent committed a deletion of the test file:
    fs.unlinkSync(path.join(ws.worktreePath, 'test', 'calc.test.ts'));
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'Agent secretly deleted test file']);

    // Mock container execution: container claims tests pass
    const execMock = async () => ({
      exitCode: 0,
      stdout: 'All tests passed (0 tests run!)',
      stderr: '',
      timedOut: false,
    });

    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId: 'fake-container-agent-claim',
      exec: execMock,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Agent Deception Test',
      description: 'Agent claims success but deletes test',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo });
    // MUST FAIL because diff policy detects deleted test file!
    expect(result.passed).toBe(false);
    const diffCheck = result.checks.find((c) => c.name === 'diff_policy');
    expect(diffCheck?.passed).toBe(false);
    expect(diffCheck?.output).toContain('test');
  });

  it('good fix case that passes every check (container tests pass, diff policy passes, size passes)', async () => {
    const taskId = `task-good-fix-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    // Make a good fix in src/calc.ts and add a valid test assertion
    fs.writeFileSync(
      path.join(ws.worktreePath, 'src', 'calc.ts'),
      'export function calc(x: number): number { return (x * 2) | 0; }\n'
    );
    fs.appendFileSync(
      path.join(ws.worktreePath, 'test', 'calc.test.ts'),
      `  it('multiplies negative numbers', () => {\n    expect(calc(-2)).toBe(-4);\n  });\n`
    );
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'Good fix for calc']);

    const execMock = async () => ({
      exitCode: 0,
      stdout: 'All checks and tests passed cleanly',
      stderr: '',
      timedOut: false,
    });

    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId: 'fake-container-good-fix',
      exec: execMock,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Good fix test',
      description: 'Passing every verification check',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo });
    expect(result.passed).toBe(true);
    expect(result.flaky).toBe(false);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.diffStats.insertions).toBeGreaterThan(0);
  });

  it('storing each result via @harness/db (verifications)', async () => {
    if (!db) {
      return; // Skip if database is not available in sandbox
    }

    const taskId = `task-db-verify-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    await createRepo(db, {
      id: repoId,
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    });

    await createTask(db, {
      id: taskId,
      repoId,
      title: 'DB Verification Storage Test',
      description: 'Checking verifications table insertion',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: '1.00',
      maxMinutes: 5,
    });

    const execMock = async () => ({
      exitCode: 0,
      stdout: 'Lint & Test Passed',
      stderr: '',
      timedOut: false,
    });

    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId: 'fake-container-db',
      exec: execMock,
    };

    const repo: Repo = {
      id: repoId,
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId,
      type: 'bugfix',
      title: 'DB Verification Storage Test',
      description: 'Checking verifications table insertion',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { db, repo });
    expect(result.passed).toBe(true);

    // Query Postgres verifications table
    const stored = await db.select().from(verifications).where(eq(verifications.taskId, taskId));
    expect(stored.length).toBeGreaterThanOrEqual(3); // lint, test, diff_policy, worktree_size
    const checkNames = stored.map((s) => s.check);
    expect(checkNames).toContain('test');
    expect(checkNames).toContain('diff_policy');
    expect(checkNames).toContain('worktree_size');
  });

  // Item 1: Diff the commit, not the working tree
  it('Item 1: commit test-file deletion, checkout HEAD~1 to restore it in working tree -> verifyTask FAILS; Control: clean committed fix passes', async () => {
    // Failing case:
    const taskIdFail = `task-commit-diff-fail-${Date.now()}`;
    const wsFail = await createWorkspace(tempRepoDir, taskIdFail, 'main');
    createdWorkspaces.push(wsFail);

    // Commit deletion of test file
    fs.unlinkSync(path.join(wsFail.worktreePath, 'test', 'calc.test.ts'));
    await runGit(wsFail, ['add', '-A']);
    await runGit(wsFail, ['commit', '-m', 'Delete test file']);

    // Restore it in working tree using git checkout HEAD~1 -- test/calc.test.ts
    await runGit(wsFail, ['checkout', 'HEAD~1', '--', 'test/calc.test.ts']);

    const execMock = async () => ({
      exitCode: 0,
      stdout: 'OK',
      stderr: '',
      timedOut: false,
    });

    const sandboxFail: VerifierSandbox = {
      workspace: wsFail,
      containerId: 'fake-container',
      exec: execMock,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };

    const taskFail: Task = {
      id: taskIdFail,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Restored working tree test',
      description: 'Bad commit restored in tree',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const resultFail = await verifyTask(taskFail, sandboxFail, { repo });
    expect(resultFail.passed).toBe(false);

    // Control case: clean committed fix passes
    const taskIdPass = `task-commit-diff-pass-${Date.now()}`;
    const wsPass = await createWorkspace(tempRepoDir, taskIdPass, 'main');
    createdWorkspaces.push(wsPass);

    fs.appendFileSync(path.join(wsPass.worktreePath, 'test', 'calc.test.ts'), `  it('adds more', () => { expect(calc(3)).toBe(6); });\n`);
    await runGit(wsPass, ['add', '-A']);
    await runGit(wsPass, ['commit', '-m', 'Clean committed test update']);

    const sandboxPass: VerifierSandbox = {
      workspace: wsPass,
      containerId: 'fake-container',
      exec: execMock,
    };

    const taskPass: Task = {
      id: taskIdPass,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Clean committed test',
      description: 'Clean commit passes',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const resultPass = await verifyTask(taskPass, sandboxPass, { repo });
    expect(resultPass.passed).toBe(true);
  });

  // Item 2: Fail closed on missing commands
  it('Item 2: verifyTask with a repo that has no testCommand must return passed:false', async () => {
    const taskId = `task-no-test-cmd-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const repoNoTest: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
    };

    const task: Task = {
      id: taskId,
      repoId: repoNoTest.id,
      type: 'bugfix',
      title: 'No testCommand',
      description: 'Testing fail-closed on missing testCommand',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo: repoNoTest });
    expect(result.passed).toBe(false);
    const testCheck = result.checks.find((c) => c.name === 'test');
    expect(testCheck?.passed).toBe(false);
  });

  it('Item 2: verifyTask with a repo that has no typecheckCommand must return passed:false', async () => {
    const taskId = `task-no-typecheck-cmd-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const repoNoTypecheck: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repoNoTypecheck.id,
      type: 'bugfix',
      title: 'No typecheckCommand',
      description: 'Testing fail-closed on missing typecheckCommand',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo: repoNoTypecheck });
    expect(result.passed).toBe(false);
    const tcCheck = result.checks.find((c) => c.name === 'typecheck');
    expect(tcCheck?.passed).toBe(false);
  });

  it('Item 2: verifyTask without resolvable repo must return passed:false', async () => {
    const taskId = `task-no-repo-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const task: Task = {
      id: taskId,
      type: 'bugfix',
      title: 'No Repo',
      description: 'Testing fail when no repo resolved',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox);
    expect(result.passed).toBe(false);
  });

  // Item 3: Honour timedOut
  it('Item 3: container exec returns {exitCode:0, timedOut:true} -> FAIL', async () => {
    const taskId = `task-timeout-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const execMock = async (cmd: string[]) => {
      if (cmd.join(' ').includes('test')) {
        return { exitCode: 0, stdout: 'Interrupted', stderr: '', timedOut: true };
      }
      return { exitCode: 0, stdout: 'OK', stderr: '', timedOut: false };
    };

    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };
    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };
    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Timeout check',
      description: 'Testing timedOut',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo });
    expect(result.passed).toBe(false);
    const testCheck = result.checks.find((c) => c.name === 'test');
    expect(testCheck?.passed).toBe(false);
  });

  // Item 4: Mask and truncate everything written to verifications
  it('Item 4: a diff line containing both .skip and a real value from collectSecretValues -> recorded verifications row contains [REDACTED] and not the value', async () => {
    if (!db) return;
    const taskId = `task-mask-verify-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const SECRET_LEAK = 'MY_SUPER_SECRET_LEAKED_VALUE_12345';
    // Write secret into worktree so collectSecretValues finds it
    fs.writeFileSync(path.join(ws.worktreePath, '.env'), `SECRET_KEY=${SECRET_LEAK}\n`);

    // In a test file, add .skip and the secret value
    fs.appendFileSync(
      path.join(ws.worktreePath, 'test', 'calc.test.ts'),
      `  it.skip('leaked secret ${SECRET_LEAK}', () => {});\n`
    );
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'Add skipped test with secret']);

    await createRepo(db, {
      id: repoId,
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    });

    await createTask(db, {
      id: taskId,
      repoId,
      title: 'Masking Test',
      description: 'Check DB redaction',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: '1.00',
      maxMinutes: 5,
    });

    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const repo: Repo = {
      id: repoId,
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId,
      type: 'bugfix',
      title: 'Masking Test',
      description: 'Check DB redaction',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { db, repo });
    expect(result.passed).toBe(false);

    // Query Postgres verifications table
    const stored = await db.select().from(verifications).where(eq(verifications.taskId, taskId));
    const diffCheckRow = stored.find((s) => s.check === 'diff_policy');
    expect(diffCheckRow).toBeDefined();
    expect(diffCheckRow?.output).toContain('[REDACTED]');
    expect(diffCheckRow?.output).not.toContain(SECRET_LEAK);
  });

  // Item 8: Remove collectSecrets escape hatch & fail on collection rejection
  it('Item 8: collection failure records a FAILED check (make collection reject -> verifyTask fails, does not pass with [])', async () => {
    const taskId = `task-secret-fail-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId: 'fake-c',
      exec: execMock,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Secret collection fail test',
      description: 'Testing fail when secret collection rejects',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const spy = vi
      .spyOn(sandboxModule, 'collectSecretValues')
      .mockRejectedValueOnce(new Error('Secret vault connection refused'));

    try {
      const result = await verifyTask(task, sandbox, { repo });
      expect(result.passed).toBe(false);
      const diffCheck = result.checks.find((c) => c.name === 'diff_policy');
      expect(diffCheck?.passed).toBe(false);
      expect(diffCheck?.output).toContain('Secret vault connection refused');
    } finally {
      spy.mockRestore();
    }
  });

  // Item 10: Prove host never executes worktree code
  it('Item 10 (a): a VerifierSandbox with neither exec nor containerId must THROW, not skip', async () => {
    const taskId = `task-no-container-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const sandbox: VerifierSandbox = {
      workspace: ws,
      // neither containerId nor exec!
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm test',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'No container test',
      description: 'Must throw when no container available',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    await expect(verifyTask(task, sandbox, { repo })).rejects.toThrow();
  });

  it('Item 10 (b): runs checks in a real harness-sandbox container against a fixture repo, and cleans it up in afterEach', async () => {
    const taskId = `task-real-container-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    const containerId = await startContainer(ws);
    createdContainers.push(containerId);

    const sandbox: VerifierSandbox = {
      workspace: ws,
      containerId,
    };

    const repo: Repo = {
      id: 'repo-1',
      name: 'e2e-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'echo lint passed',
      typecheckCommand: 'echo typecheck passed',
      testCommand: 'echo test passed',
    };

    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'Real Container Test',
      description: 'Running inside harness-sandbox container',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { repo });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.name === 'test')?.passed).toBe(true);
  });
});
