import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Repo, Task } from '@harness/core';
import { runGit, createWorkspace, destroy, type Workspace } from '@harness/sandbox';
import { verifyTask, evaluateDiffPolicy, type VerifierSandbox } from '../src/index.js';

/**
 * Round 3, risk 2: when a patch header carried no usable path, the chunk was matched to a
 * path BY POSITION — a guess. A pure mode change produces exactly that shape: a
 * "diff --git" header with old mode/new mode and no ---/+++ lines and no hunks.
 *
 * Guessing is the wrong failure mode for a security check, so an unresolved chunk must
 * become a named failed check instead.
 */
describe('diff_parse_unresolved', { timeout: 30000 }, () => {
  let tempRepoDir: string;
  let createdWorkspaces: Workspace[] = [];

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-r3-parse-'));
    await runGit(tempRepoDir, ['init', '-b', 'main']);
    await runGit(tempRepoDir, ['config', 'user.name', 'Test Verifier']);
    await runGit(tempRepoDir, ['config', 'user.email', 'verifier@example.com']);
    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify({ name: 'r3-parse', version: '1.0.0', scripts: {} }, null, 2)
    );
    fs.writeFileSync(path.join(tempRepoDir, 'run.sh'), '#!/bin/sh\necho hello\n');
    fs.mkdirSync(path.join(tempRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRepoDir, 'src', 'calc.ts'), 'export const calc = () => 2;\n');
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
      // repo already removed
    }
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('a pure mode change produces an unresolved-chunk violation rather than a guessed path', async () => {
    await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
    fs.chmodSync(path.join(tempRepoDir, 'run.sh'), 0o755);
    await runGit(tempRepoDir, ['add', '-A']);
    await runGit(tempRepoDir, ['commit', '-m', 'make run.sh executable']);

    // Confirm the fixture really is a bare mode change with no ---/+++ lines.
    const { stdout: rawDiff } = await runGit(tempRepoDir, ['diff', 'main', 'HEAD']);
    expect(String(rawDiff)).toContain('old mode');
    expect(String(rawDiff)).not.toContain('+++ b/');

    const result = await evaluateDiffPolicy(tempRepoDir, 'main');

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('diff_parse_unresolved'))).toBe(true);
    expect(result.unresolvedChunks.length).toBeGreaterThan(0);
  });

  it('verifyTask surfaces it as a named failed check', async () => {
    const taskId = `task-r3-parse-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    fs.chmodSync(path.join(ws.worktreePath, 'run.sh'), 0o755);
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'make run.sh executable']);

    const repo: Repo = {
      id: 'repo-parse',
      name: 'r3-parse-repo',
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
      title: 'mode change',
      description: 'risk 2',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };
    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const result = await verifyTask(task, sandbox, { repo });

    const check = result.checks.find((c) => c.name === 'diff_parse_unresolved');
    expect(check).toBeDefined();
    expect(check?.passed).toBe(false);
    expect(check?.rule).toBe('diff_parse_unresolved');
    expect(result.passed).toBe(false);
  });

  it('PASS (control): an ordinary content change resolves every chunk and adds no such check', async () => {
    const taskId = `task-r3-parse-ok-${Date.now()}`;
    const ws = await createWorkspace(tempRepoDir, taskId, 'main');
    createdWorkspaces.push(ws);

    fs.writeFileSync(path.join(ws.worktreePath, 'src', 'calc.ts'), 'export const calc = () => 3;\n');
    await runGit(ws, ['add', '-A']);
    await runGit(ws, ['commit', '-m', 'ordinary content change']);

    const policy = await evaluateDiffPolicy(ws, 'main');
    expect(policy.unresolvedChunks).toEqual([]);
    expect(policy.violations.some((v) => v.includes('diff_parse_unresolved'))).toBe(false);

    const repo: Repo = {
      id: 'repo-parse-ok',
      name: 'r3-parse-ok-repo',
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
      title: 'ordinary change',
      description: 'control',
      status: 'verifying',
      attempt: 1,
      maxSteps: 10,
      maxCostUsd: 1,
      maxMinutes: 5,
    };
    const execMock = async () => ({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false });
    const sandbox: VerifierSandbox = { workspace: ws, containerId: 'fake-c', exec: execMock };

    const result = await verifyTask(task, sandbox, { repo });

    expect(result.checks.find((c) => c.name === 'diff_parse_unresolved')).toBeUndefined();
    expect(result.passed).toBe(true);
  });
});
