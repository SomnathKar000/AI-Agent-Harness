import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Repo, Task } from '@harness/core';
import type { Database } from '@harness/db';
import { runGit, createWorkspace, destroy, type Workspace } from '@harness/sandbox';
import { verifyTask, type VerifierSandbox } from '../src/index.js';

/**
 * Round 3, risk 4: when recordVerification rejects, verifier.ts logged the raw error with
 * console.error. A DB driver happily puts the offending parameter values into its message,
 * so that log path bypassed maskAndTruncate entirely.
 */
describe('DB error logging is masked', { timeout: 30000 }, () => {
  let tempRepoDir: string;
  let createdWorkspaces: Workspace[] = [];

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-r3-dberr-'));
    await runGit(tempRepoDir, ['init', '-b', 'main']);
    await runGit(tempRepoDir, ['config', 'user.name', 'Test Verifier']);
    await runGit(tempRepoDir, ['config', 'user.email', 'verifier@example.com']);
    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify({ name: 'r3-dberr', version: '1.0.0', scripts: {} }, null, 2)
    );
    fs.writeFileSync(path.join(tempRepoDir, '.gitignore'), '.env\nnode_modules\n');
    await runGit(tempRepoDir, ['add', '-A']);
    await runGit(tempRepoDir, ['commit', '-m', 'initial commit']);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ws of createdWorkspaces) {
      try {
        await destroy(undefined, ws);
      } catch {
        // best effort
      }
    }
    createdWorkspaces = [];
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('a recordVerification rejection carrying a secret is logged as [REDACTED]', async () => {
    const SECRET_LEAK = 'R3_DB_ERROR_SECRET_VALUE_8c41d';

    const taskId = `task-r3-dberr-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    // The secret is in the worktree, so collectSecretValues picks it up and it is part of
    // the mask set by the time any verification row is written.
    fs.writeFileSync(path.join(ws.worktreePath, '.env'), `SECRET_KEY=${SECRET_LEAK}\n`);

    // A DB that rejects with the offending value embedded in the message, the way a driver
    // reports a failing parameterised statement.
    const rejectingDb = {
      insert: () => {
        throw new Error(
          `duplicate key value violates unique constraint; DETAIL: Key (output)=(${SECRET_LEAK}) already exists.`
        );
      },
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as unknown as Database;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const repo: Repo = {
      id: 'repo-dberr',
      name: 'r3-dberr-repo',
      localPath: tempRepoDir,
      defaultBranch: 'main',
      lintCommand: 'echo lint',
      typecheckCommand: 'echo typecheck',
      testCommand: 'echo test',
    };
    const task: Task = {
      id: taskId,
      repoId: repo.id,
      type: 'bugfix',
      title: 'db error masking',
      description: 'risk 4',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };

    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    await verifyTask(task, sandbox, { db: rejectingDb, repo });

    expect(errorSpy).toHaveBeenCalled();

    const logged = errorSpy.mock.calls
      .map((call) => call.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
      .join('\n');

    expect(logged).not.toContain(SECRET_LEAK);
    expect(logged).toContain('[REDACTED]');
    // The surrounding diagnostic must survive, otherwise the log is useless.
    expect(logged).toContain('duplicate key value violates unique constraint');
  });
});
