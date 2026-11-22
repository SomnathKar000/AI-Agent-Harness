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

/**
 * Sanitizes verification check output before writing to database.
 * Ordering: mask -> truncate -> write (same 2048-char truncation as PolicyGate).
 */
function sanitizeVerificationOutput(
  output: string | null | undefined,
  secrets: string[]
): string | null {
  if (output === null || output === undefined) return null;
  let masked = String(output);
  for (const secret of secrets) {
    if (secret && typeof secret === 'string' && secret.length >= 8) {
      masked = masked.replaceAll(secret, '[REDACTED]');
    }
  }
  if (masked.length > 2048) {
    const truncatedBytes = Buffer.byteLength(masked.slice(2048));
    masked = masked.slice(0, 2048) + ` [truncated ${truncatedBytes} bytes]`;
  }
  return masked;
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

  // 2. Resolve repository configuration (no silent fallback - fail closed if unresolved)
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
    const failCheck: VerificationCheck = {
      name: 'repo_resolution',
      passed: false,
      output: 'Failed to resolve repository configuration',
    };
    if (db) {
      try {
        await recordVerification(db, {
          id: crypto.randomUUID(),
          taskId: task.id,
          check: failCheck.name,
          passed: false,
          output: failCheck.output ?? null,
        });
      } catch {
        // ignore
      }
    }
    return {
      passed: false,
      checks: [failCheck],
      diffStats: { insertions: 0, deletions: 0, filesChanged: 0, totalLines: 0 },
      flaky: false,
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
  const diffPolicyResult = await evaluateDiffPolicy(ws, ws.baseBranch ?? 'main', {
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

  // STEP 4: Store each result via @harness/db (verifications), masking secrets and truncating
  if (db) {
    for (const check of allChecks) {
      const sanitizedOutput = sanitizeVerificationOutput(
        check.output,
        diffPolicyResult.effectiveSecrets ?? []
      );
      try {
        await recordVerification(db, {
          id: crypto.randomUUID(),
          taskId: task.id,
          check: check.name,
          passed: check.passed,
          output: sanitizedOutput,
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
