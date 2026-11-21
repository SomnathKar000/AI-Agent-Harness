import crypto from 'node:crypto';
import type { Task, Repo } from '@harness/core';
import { recordVerification, repos, approvals, eq, and, type Database } from '@harness/db';
import type { Workspace } from '@harness/sandbox';
import type {
  VerifierTask,
  VerifierSandbox,
  VerifyOptions,
  VerifyResult,
  VerificationCheck,
} from './types.js';
import { runContainerChecks } from './container-runner.js';
import { evaluateDiffPolicy } from './diff-policy.js';
import { checkWorktreeSize } from './worktree-size.js';

function isWorkspace(target: unknown): target is Workspace {
  return (
    typeof target === 'object' &&
    target !== null &&
    'worktreePath' in target &&
    'taskId' in target &&
    'repoPath' in target
  );
}

export async function verifyTask(
  task: Task | VerifierTask,
  sandbox: Workspace | VerifierSandbox,
  options?: VerifyOptions
): Promise<VerifyResult> {
  const db: Database | undefined = options?.db;

  // 1. Normalize workspace and verifier sandbox
  let ws: Workspace;
  let verifierSandbox: VerifierSandbox;

  if (isWorkspace(sandbox)) {
    ws = sandbox;
    verifierSandbox = {
      workspace: ws,
      containerId: task.containerId ?? undefined,
    };
  } else {
    ws = sandbox.workspace;
    verifierSandbox = sandbox;
  }

  // 2. Resolve repository configuration
  let repo: Repo | undefined = options?.repo ?? ('repo' in task ? task.repo ?? undefined : undefined);

  if (!repo && db && task.repoId) {
    try {
      const [found] = await db.select().from(repos).where(eq(repos.id, task.repoId));
      if (found) {
        repo = found as Repo;
      }
    } catch {
      // ignore
    }
  }

  if (!repo) {
    repo = {
      id: task.repoId ?? 'default',
      name: 'default-repo',
      localPath: ws.repoPath,
      defaultBranch: ws.baseBranch ?? 'main',
    };
  }

  // 3. Resolve approved asks from database if available
  const approvedAsks = new Set<string>(options?.approvedAsks ?? []);
  if (db) {
    try {
      const dbApprovals = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.taskId, task.id), eq(approvals.status, 'approved')));

      for (const app of dbApprovals) {
        if (app.payload && typeof app.payload === 'object') {
          const payloadObj = app.payload as Record<string, unknown>;
          const toolCall = payloadObj.toolCall as Record<string, unknown> | undefined;
          const input = toolCall?.input as Record<string, unknown> | undefined;
          const targetPath =
            input?.path ??
            payloadObj.path ??
            payloadObj.file;
          if (typeof targetPath === 'string') {
            approvedAsks.add(targetPath);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const allChecks: VerificationCheck[] = [];
  let isFlaky = false;

  // STEP 1: Inside the container only: lint, typecheck, tests (with flaky rerun on tests)
  const containerResult = await runContainerChecks(verifierSandbox, repo);
  allChecks.push(...containerResult.checks);
  if (containerResult.flaky) {
    isFlaky = true;
  }

  // STEP 2: Diff policy, computed on the host with runGit against base branch
  const diffPolicyResult = await evaluateDiffPolicy(ws, ws.baseBranch, {
    ...options,
    approvedAsks: Array.from(approvedAsks),
  });

  allChecks.push({
    name: 'diff_policy',
    passed: diffPolicyResult.passed,
    output:
      diffPolicyResult.violations.length > 0
        ? diffPolicyResult.violations.join('\n')
        : 'Diff policy passed',
    reviewItem: diffPolicyResult.reviewItems.length > 0,
  });

  // STEP 3: Check worktree size (default 500MB)
  const sizeResult = await checkWorktreeSize(ws.worktreePath, options?.maxWorktreeBytes);
  allChecks.push({
    name: 'worktree_size',
    passed: sizeResult.passed,
    output: `Worktree size: ${sizeResult.sizeBytes} bytes (limit: ${sizeResult.limitBytes} bytes)`,
  });

  // STEP 4: Store each result via @harness/db (verifications)
  if (db) {
    for (const check of allChecks) {
      try {
        await recordVerification(db, {
          id: crypto.randomUUID(),
          taskId: task.id,
          check: check.name,
          passed: check.passed,
          output: check.output ?? null,
        });
      } catch (dbErr) {
        console.error(`Failed to record verification in DB for ${check.name}:`, dbErr);
      }
    }
  }

  const overallPassed = allChecks.every((c) => c.passed);

  return {
    passed: overallPassed,
    checks: allChecks,
    diffStats: diffPolicyResult.diffStats,
    flaky: isFlaky,
  };
}
