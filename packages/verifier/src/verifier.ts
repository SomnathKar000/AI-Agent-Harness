import crypto from 'node:crypto';
import { maskAndTruncate, type Task, type Repo } from '@harness/core';
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

function failure(
  check: VerificationCheck,
  db?: Database,
  taskId?: string
): Promise<VerifyResult> | VerifyResult {
  const result: VerifyResult = {
    passed: false,
    checks: [check],
    diffStats: { insertions: 0, deletions: 0, filesChanged: 0, totalLines: 0 },
    flaky: false,
  };
  if (db && taskId) {
    return recordVerification(db, {
      id: crypto.randomUUID(),
      taskId,
      check: check.name,
      passed: false,
      // No secrets are available at this point, so masking has nothing to remove; the
      // truncation bound still applies.
      output: maskAndTruncate(check.output ?? '', []),
    })
      .then(() => result)
      .catch(() => result);
  }
  return result;
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
    verifierSandbox = { workspace: ws, containerId: task.containerId ?? undefined };
  } else {
    ws = sandbox.workspace;
    verifierSandbox = sandbox;
  }

  // 2. Resolve the repo. No fallback repo: an unresolved repo is a failure, and a DB error
  //    while looking it up is reported rather than swallowed.
  let repo: Repo | undefined =
    options?.repo ?? ('repo' in task ? task.repo ?? undefined : undefined);

  if (!repo && db && task.repoId) {
    try {
      const [found] = await db.select().from(repos).where(eq(repos.id, task.repoId));
      if (found) repo = found as Repo;
    } catch (err: unknown) {
      return failure(
        {
          name: 'repo_resolution',
          passed: false,
          rule: 'repo_lookup_failed',
          output: `Repository lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        db,
        task.id
      );
    }
  }

  if (!repo) {
    return failure(
      {
        name: 'repo_resolution',
        passed: false,
        rule: 'repo_not_resolved',
        output: 'Failed to resolve repository configuration',
      },
      db,
      task.id
    );
  }

  // 3. The base branch must be configured. No silent default to 'main'.
  const baseBranch = ws.baseBranch ?? ('baseBranch' in task ? task.baseBranch : undefined);
  if (typeof baseBranch !== 'string' || baseBranch.trim().length === 0) {
    return failure(
      {
        name: 'base_branch_resolution',
        passed: false,
        rule: 'base_branch_not_configured',
        output: 'Failed to resolve the base branch for this task',
      },
      db,
      task.id
    );
  }

  // 4. Approved asks. A DB error here is a failure: silently approving fewer paths would be
  //    stricter, but silently approving the wrong set is not something to guess at.
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
          const targetPath = input?.path ?? payloadObj.path ?? payloadObj.file;
          if (typeof targetPath === 'string') approvedAsks.add(targetPath);
        }
      }
    } catch (err: unknown) {
      return failure(
        {
          name: 'approval_resolution',
          passed: false,
          rule: 'approval_lookup_failed',
          output: `Approval lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        db,
        task.id
      );
    }
  }

  const allChecks: VerificationCheck[] = [];
  let isFlaky = false;

  // STEP 1: container only — lint, typecheck, tests
  const containerResult = await runContainerChecks(verifierSandbox, repo);
  allChecks.push(...containerResult.checks);
  if (containerResult.flaky) isFlaky = true;

  // STEP 2: diff policy on the host, against the merge base and HEAD
  const diffPolicyResult = await evaluateDiffPolicy(ws, baseBranch, {
    ...options,
    approvedAsks: Array.from(approvedAsks),
  });

  // worktree_clean is its own named check, not a line buried in diff_policy.
  allChecks.push({
    name: 'worktree_clean',
    passed: diffPolicyResult.worktreeClean,
    rule: diffPolicyResult.worktreeClean ? undefined : 'worktree_dirty',
    output: diffPolicyResult.worktreeClean
      ? 'Worktree is clean'
      : diffPolicyResult.violations.filter((v) => v.startsWith('worktree_')).join('\n') ||
        'Worktree is not clean',
  });

  // So is the secret scan: a scan that did not run is not a scan that found nothing.
  allChecks.push({
    name: 'secret_scan',
    passed: diffPolicyResult.secretScanRan,
    rule: diffPolicyResult.secretScanRan ? undefined : 'secret_scan_not_run',
    output: diffPolicyResult.secretScanRan
      ? `Secret scan ran against ${diffPolicyResult.effectiveSecrets.length} collected value(s)`
      : diffPolicyResult.violations.filter((v) => v.startsWith('secret_scan_not_run')).join('\n') ||
        'Secret scan did not run',
  });

  // diff_policy still reports every violation, including the dirty worktree and a failed
  // secret scan. The two checks above are an addition, not a reassignment: a reviewer reading
  // diff_policy alone must not miss them.
  allChecks.push({
    name: 'diff_policy',
    passed: diffPolicyResult.passed,
    output:
      diffPolicyResult.violations.length > 0
        ? diffPolicyResult.violations.join('\n')
        : 'Diff policy passed',
    reviewItem: diffPolicyResult.reviewItems.length > 0,
  });

  // STEP 3: worktree size
  const sizeResult = await checkWorktreeSize(ws.worktreePath, options?.maxWorktreeBytes);
  allChecks.push({
    name: 'worktree_size',
    passed: sizeResult.passed,
    rule: sizeResult.passed ? undefined : 'worktree_too_large',
    output: `Worktree size: ${sizeResult.earlyExit ? 'at least ' : ''}${
      sizeResult.sizeBytes
    } bytes (limit: ${sizeResult.limitBytes} bytes, ${sizeResult.entriesVisited} entries visited)`,
  });

  // STEP 4: persist. Mask with the collected secrets, then truncate, then write.
  if (db) {
    for (const check of allChecks) {
      try {
        await recordVerification(db, {
          id: crypto.randomUUID(),
          taskId: task.id,
          check: check.name,
          passed: check.passed,
          output:
            check.output === null || check.output === undefined
              ? null
              : maskAndTruncate(String(check.output), diffPolicyResult.effectiveSecrets),
        });
      } catch (dbErr) {
        console.error(`Failed to record verification in DB for ${check.name}:`, dbErr);
      }
    }
  }

  // The returned report is masked too: the worker consumes this, not just the DB rows.
  const maskedChecks = allChecks.map((check) => ({
    ...check,
    output:
      check.output === undefined
        ? undefined
        : maskAndTruncate(String(check.output), diffPolicyResult.effectiveSecrets),
  }));

  // An empty checks array is never a pass.
  const overallPassed = maskedChecks.length > 0 && maskedChecks.every((c) => c.passed);

  return {
    passed: overallPassed,
    checks: maskedChecks,
    diffStats: diffPolicyResult.diffStats,
    flaky: isFlaky,
  };
}
