import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Repo, Task } from '@harness/core';
import {
  createDb,
  runMigrations,
  createRepo,
  createTask,
  verifications,
  eq,
  type Database,
} from '@harness/db';
import { runGit, createWorkspace, destroy, type Workspace } from '@harness/sandbox';
import { verifyTask, type VerifierSandbox } from '../src/index.js';

const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  'postgresql://harness@127.0.0.1:5433/harness_test';
const TEST_APP_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://harness_app@127.0.0.1:5433/harness_test';

/**
 * Round 3, item 5: mask-then-truncate on the way into `verifications`.
 *
 * Violations no longer echo source lines, so this proves masking where raw text still
 * legitimately flows into a row: the output of a command run in the container.
 */
describe('Verification row masking', { timeout: 30000 }, () => {
  let db: Database | undefined;
  let tempRepoDir: string;
  let createdWorkspaces: Workspace[] = [];

  beforeAll(async () => {
    try {
      await runMigrations(TEST_ADMIN_URL);
      db = createDb(TEST_APP_URL);
    } catch {
      db = undefined;
    }
  });

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-r3-mask-'));
    await runGit(tempRepoDir, ['init', '-b', 'main']);
    await runGit(tempRepoDir, ['config', 'user.name', 'Test Verifier']);
    await runGit(tempRepoDir, ['config', 'user.email', 'verifier@example.com']);
    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify({ name: 'r3-mask', version: '1.0.0', scripts: {} }, null, 2)
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
    } catch {
      // repo already gone
    }
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('a secret printed by a container command is [REDACTED] in the verifications row and in the returned report', async () => {
    if (!db) return;

    const taskId = `task-r3-mask-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const SECRET_LEAK = 'R3_CONTAINER_OUTPUT_SECRET_9f2b1c';

    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    // The secret lives in the worktree, so collectSecretValues picks it up.
    fs.writeFileSync(path.join(ws.worktreePath, '.env'), `SECRET_KEY=${SECRET_LEAK}\n`);

    await createRepo(db, {
      id: repoId,
      name: 'r3-mask-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'echo lint',
      typecheckCommand: 'echo typecheck',
      testCommand: 'echo test',
    });
    await createTask(db, {
      id: taskId,
      repoId,
      title: 'Masking',
      description: 'container output masking',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: '1.00',
      maxMinutes: 5,
    });

    // The command "prints" the secret, exactly as a failing test log would.
    const execMock = async () => ({
      exitCode: 1,
      stdout: `FAIL: connecting with token ${SECRET_LEAK}\n`,
      stderr: `retry with ${SECRET_LEAK}\n`,
      timedOut: false,
    });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const repo: Repo = {
      id: repoId,
      name: 'r3-mask-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'echo lint',
      typecheckCommand: 'echo typecheck',
      testCommand: 'echo test',
    };
    const task: Task = {
      id: taskId,
      repoId,
      type: 'bugfix',
      title: 'Masking',
      description: 'container output masking',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const result = await verifyTask(task, sandbox, { db, repo });

    expect(result.passed).toBe(false);

    const stored = await db.select().from(verifications).where(eq(verifications.taskId, taskId));
    expect(stored.length).toBeGreaterThan(0);

    const lintRow = stored.find((s) => s.check === 'lint');
    expect(lintRow?.output).toContain('[REDACTED]');
    for (const row of stored) {
      expect(row.output ?? '').not.toContain(SECRET_LEAK);
    }

    // The returned report is masked too: the worker consumes this, not only the DB rows.
    for (const check of result.checks) {
      expect(check.output ?? '').not.toContain(SECRET_LEAK);
    }
    expect(result.checks.find((c) => c.name === 'lint')?.output).toContain('[REDACTED]');
  });

  it('long output is masked first and truncated second, so a secret cannot survive at the cut', async () => {
    if (!db) return;

    const taskId = `task-r3-trunc-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const SECRET_LEAK = 'R3_TRUNCATION_BOUNDARY_SECRET_4a7e';

    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);
    fs.writeFileSync(path.join(ws.worktreePath, '.env'), `SECRET_KEY=${SECRET_LEAK}\n`);

    await createRepo(db, {
      id: repoId,
      name: 'r3-trunc-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'echo lint',
      typecheckCommand: 'echo typecheck',
      testCommand: 'echo test',
    });
    await createTask(db, {
      id: taskId,
      repoId,
      title: 'Truncation',
      description: 'mask before truncate',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: '1.00',
      maxMinutes: 5,
    });

    // Put the secret right at the 2048-character boundary.
    const padding = 'x'.repeat(2040);
    const execMock = async () => ({
      exitCode: 1,
      stdout: `${padding}${SECRET_LEAK}${padding}`,
      stderr: '',
      timedOut: false,
    });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const repo: Repo = {
      id: repoId,
      name: 'r3-trunc-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'echo lint',
      typecheckCommand: 'echo typecheck',
      testCommand: 'echo test',
    };
    const task: Task = {
      id: taskId,
      repoId,
      type: 'bugfix',
      title: 'Truncation',
      description: 'mask before truncate',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    await verifyTask(task, sandbox, { db, repo });

    const stored = await db.select().from(verifications).where(eq(verifications.taskId, taskId));
    for (const row of stored) {
      const output = row.output ?? '';
      expect(output).not.toContain(SECRET_LEAK);
      // No partial secret survives the cut either.
      expect(output).not.toContain(SECRET_LEAK.slice(0, 16));
    }
    const lintRow = stored.find((s) => s.check === 'lint');
    expect(lintRow?.output).toContain('[REDACTED]');
    expect(lintRow?.output).toContain('[truncated');
  });
});
