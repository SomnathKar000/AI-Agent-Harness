import crypto from 'node:crypto';
import { maskAndTruncate, type TaskStatus } from '@harness/core';
import {
  getTask,
  getRepo,
  setTaskFields,
  transitionTask,
  createApproval,
  ConcurrentTransitionError,
  type Database,
} from '@harness/db';
import { SandboxToolExecutor, type LLMClient, type ModelPricing } from '@harness/agent';
import type { Workspace, ContainerLimits } from '@harness/sandbox';
import type { VerifyResult } from '@harness/verifier';
import { InfraError, CancelledError, asInfraError } from './errors.js';
import { createDbStepLogger } from './step-logger.js';
import {
  DEFAULT_CONTAINER_LIMITS,
  type SandboxPort,
  type AgentPort,
  type VerifierPort,
  type GateFactory,
  type ApprovalWaiterFactory,
  defaultCreateApprovalWaiter,
} from './ports.js';

export interface PipelineDeps {
  db: Database;
  sandbox: SandboxPort;
  agent: AgentPort;
  verifier: VerifierPort;
  createGate: GateFactory;
  llm: LLMClient;
  /** Agent runs after a failed verification. Default 2. */
  maxVerifyFixLoops?: number;
  /** How often the cancel watcher re-reads the task status from Postgres. Default 2000ms. */
  cancelPollMs?: number;
  /** Builds the waiter used when policy returns `ask`. Defaults to the Postgres one. */
  createApprovalWaiter?: ApprovalWaiterFactory;
  /** How often that waiter re-reads the approval row. Default 2000ms. */
  approvalPollMs?: number;
  containerLimits?: ContainerLimits;
  model?: string;
  pricingTable?: Record<string, ModelPricing>;
}

export type PipelineOutcome =
  | { taskId: string; status: 'awaiting_approval' }
  | { taskId: string; status: 'needs_info' }
  | { taskId: string; status: 'failed'; reason: string }
  | { taskId: string; status: 'cancelled' }
  | { taskId: string; status: 'skipped'; reason: string };

const DEFAULT_CANCEL_POLL_MS = 2000;
const MAX_FAILURE_REASON_CHARS = 2000;

function describeCheckFailures(result: VerifyResult): string {
  return result.checks
    .filter((c) => !c.passed)
    .map((c) => `[${c.name}${c.rule ? ` / ${c.rule}` : ''}]\n${c.output ?? ''}`.trim())
    .join('\n\n');
}

/**
 * Runs one task end to end.
 *
 * Contracts this function exists to hold:
 * - Every status change goes through `transitionTask` (hard rule 9). Nothing here writes
 *   `tasks.status`.
 * - The gate the agent runs behind carries `collectSecretValues(worktreePath)`
 *   (the Phase 6 wiring contract in packages/policy/README.md).
 * - Only infrastructure failures throw, so BullMQ retries those and nothing else.
 * - The container and worktree are destroyed in `finally`, on every path.
 */
export async function runTaskPipeline(
  taskId: string,
  deps: PipelineDeps
): Promise<PipelineOutcome> {
  const { db } = deps;
  const maxVerifyFixLoops = deps.maxVerifyFixLoops ?? 2;
  const cancelPollMs = deps.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS;

  let secretValues: string[] = [];

  const failTask = async (
    from: TaskStatus,
    reason: string
  ): Promise<PipelineOutcome> => {
    const masked = maskAndTruncate(reason, secretValues, MAX_FAILURE_REASON_CHARS);
    try {
      await transitionTask(db, taskId, from, 'failed', 'system', { reason: masked });
      await setTaskFields(db, taskId, { failureReason: masked });
    } catch (err) {
      if (err instanceof ConcurrentTransitionError) {
        // A human cancel can land between the step that failed and this write. The cancel
        // wins: it is the later, deliberate decision, and the row already says so.
        const current = await getTask(db, taskId).catch(() => null);
        if (current?.status === 'cancelled') {
          return { taskId, status: 'cancelled' };
        }
      }
      // A task that cannot be marked failed is a DB problem, and retrying the job will not
      // make the agent work; surfacing it as infra is still the honest classification.
      throw asInfraError('failed to mark task as failed', err);
    }
    return { taskId, status: 'failed', reason: masked };
  };

  // 1. Load the task. A missing row is a failure, never a retry loop.
  let task;
  try {
    task = await getTask(db, taskId);
  } catch (err) {
    throw asInfraError('task lookup failed', err);
  }
  if (!task) {
    return { taskId, status: 'failed', reason: 'task_not_found' };
  }
  if (task.status === 'cancelled') {
    return { taskId, status: 'cancelled' };
  }
  if (task.status !== 'queued') {
    return { taskId, status: 'skipped', reason: `task status is '${task.status}'` };
  }

  // 2. Resolve the repo. No fallback: an empty config value is a failure (hard rule 13).
  let repo;
  try {
    repo = await getRepo(db, task.repoId);
  } catch (err) {
    throw asInfraError('repo lookup failed', err);
  }
  if (!repo) {
    return await failTask('queued', `repo_not_found: ${task.repoId}`);
  }
  if (!repo.localPath || repo.localPath.trim().length === 0) {
    return await failTask('queued', 'repo_local_path_not_configured');
  }
  if (!repo.defaultBranch || repo.defaultBranch.trim().length === 0) {
    return await failTask('queued', 'repo_default_branch_not_configured');
  }

  // 3. Claim the task. Compare-and-set: a duplicate job loses the race and skips.
  try {
    await transitionTask(db, taskId, 'queued', 'running', 'system');
  } catch (err) {
    if (err instanceof ConcurrentTransitionError) {
      return { taskId, status: 'skipped', reason: 'task was claimed by another worker' };
    }
    throw asInfraError('failed to claim task', err);
  }

  // 4. Cancel watcher. Postgres is the source of truth (hard rule 9): the API writes
  //    'cancelled' and this poller reads it. On cancel the container is destroyed, which
  //    makes any in-flight exec fail, and the pipeline stops at the next step boundary.
  let cancelled = false;
  let containerKilled = false;
  let workspace: Workspace | undefined;
  let containerId: string | undefined;

  const poller = setInterval(() => {
    void (async () => {
      try {
        const current = await getTask(db, taskId);
        if (current?.status === 'cancelled') {
          cancelled = true;
          if (containerId && !containerKilled) {
            containerKilled = true;
            await deps.sandbox.destroy({ containerId }).catch(() => undefined);
          }
        }
      } catch {
        // A transient read failure must not kill the run; the next tick retries, and the
        // step boundaries re-check before anything irreversible happens.
      }
    })();
  }, cancelPollMs);
  if (typeof poller.unref === 'function') {
    poller.unref();
  }

  const checkCancel = (): void => {
    if (cancelled) {
      throw new CancelledError(taskId);
    }
  };

  /**
   * Every status change after the claim goes through here.
   *
   * A lost compare-and-set means something else moved the task while this step was
   * running. The common cause is a human cancel landing between two poller ticks, and the
   * raw ConcurrentTransitionError would escape as an unclassified throw that BullMQ then
   * retries against an already-cancelled task. Re-read, and unwind as cancelled if that is
   * what happened; anything else is genuinely unexpected and is reported as infra.
   */
  const transition = async (
    from: TaskStatus,
    to: TaskStatus,
    actor: 'system' | 'agent',
    detail?: Record<string, unknown>
  ): Promise<void> => {
    try {
      await transitionTask(db, taskId, from, to, actor, detail);
    } catch (err) {
      if (err instanceof ConcurrentTransitionError) {
        const current = await getTask(db, taskId).catch(() => null);
        if (current?.status === 'cancelled') {
          cancelled = true;
          throw new CancelledError(taskId);
        }
        throw asInfraError(
          `transition ${from}->${to} lost the compare-and-set (now '${current?.status ?? 'unknown'}')`,
          err
        );
      }
      throw asInfraError(`transition ${from}->${to} failed`, err);
    }
  };

  try {
    checkCancel();

    // 5. Worktree.
    try {
      workspace = await deps.sandbox.createWorkspace(
        repo.localPath,
        taskId,
        repo.defaultBranch
      );
    } catch (err) {
      throw asInfraError('createWorkspace failed', err);
    }
    await setTaskFields(db, taskId, {
      branchName: workspace.branch,
      worktreePath: workspace.worktreePath,
    });

    checkCancel();

    // 6. Install, in a short-lived container that still has network.
    let installResult;
    try {
      installResult = await deps.sandbox.installDependencies(
        workspace,
        repo.installCommand ?? undefined
      );
    } catch (err) {
      throw asInfraError('installDependencies failed', err);
    }
    if (installResult.exitCode !== 0) {
      // The output is not included: secrets have not been collected yet, so there is
      // nothing to mask it with (hard rule 14).
      throw new InfraError(
        `installDependencies exited with code ${installResult.exitCode}`
      );
    }

    // The install step writes into the worktree (a lockfile, generated files). Those are
    // the harness's own side effects, not the agent's work. They are committed here, on
    // their own, so that the branch a PR is cut from can still be installed — and the
    // agent's diff is then measured against THIS commit, not the base branch, so install
    // noise is neither attributed to the agent nor counted against the diff-size limit.
    let diffBaseRef: string;
    try {
      await deps.sandbox.commitWorktree(
        workspace,
        `harness: install artifacts for task ${taskId}`
      );
      diffBaseRef = await deps.sandbox.headSha(workspace);
    } catch (err) {
      throw asInfraError('committing install artifacts failed', err);
    }

    checkCancel();

    // 7. The locked-down task container.
    try {
      containerId = await deps.sandbox.startContainer(
        workspace,
        deps.containerLimits ?? DEFAULT_CONTAINER_LIMITS
      );
    } catch (err) {
      throw asInfraError('startContainer failed', err);
    }
    await setTaskFields(db, taskId, { containerId });

    checkCancel();

    // 8. The Phase 6 wiring contract. A collection failure fails the task: running the
    //    agent behind a gate with an empty secret registry is exactly the silent
    //    downgrade hard rule 13 forbids.
    try {
      secretValues = await deps.sandbox.collectSecretValues(workspace.worktreePath);
    } catch (err) {
      return await failTask(
        'running',
        `secret_collection_failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const gate = deps.createGate({
      workspaceRoot: workspace.worktreePath,
      taskId,
      db,
      secretValues,
    });

    const ws = workspace;
    const executor = new SandboxToolExecutor({
      readFile: (p) => deps.sandbox.readFile(ws.worktreePath, p),
      writeFile: (p, c) => deps.sandbox.writeFile(ws.worktreePath, p, c),
      listDir: (p) => deps.sandbox.listDir(ws.worktreePath, p),
      exec: (cmd, options) => deps.sandbox.exec(containerId!, cmd, options),
    });

    const logger = createDbStepLogger(db);

    // 9. Agent, then verification, with at most `maxVerifyFixLoops` fix rounds.
    let description = task.description;
    const approvalWaiter = (deps.createApprovalWaiter ?? defaultCreateApprovalWaiter)({
      db,
      taskId,
      pollMs: deps.approvalPollMs,
    });

    let fixLoops = 0;

    for (;;) {
      checkCancel();

      logger.beginRun();
      let agentResult;
      try {
        agentResult = await deps.agent.runAgent(
          {
            id: taskId,
            description,
            maxSteps: task.maxSteps,
            maxCostUsd: Number(task.maxCostUsd),
            maxMinutes: task.maxMinutes,
          },
          {
            llm: deps.llm,
            gate,
            executor,
            logger,
            model: deps.model,
            pricingTable: deps.pricingTable,
            approvalWaiter,
          }
        );
      } catch (err) {
        // A cancel reaches here when the task is cancelled while the loop is paused
        // waiting for a human approval. It is a verdict, not an infrastructure fault:
        // wrapping it in an InfraError would make BullMQ retry a cancelled task.
        if (err instanceof CancelledError) {
          cancelled = true;
          throw err;
        }
        // The loop itself failing is an LLM or transport problem, not an agent verdict.
        throw asInfraError('runAgent failed', err);
      }

      if (agentResult.status === 'needs_info') {
        checkCancel();
        const question = maskAndTruncate(
          agentResult.question,
          secretValues,
          MAX_FAILURE_REASON_CHARS
        );
        await transition('running', 'needs_info', 'agent', { question });
        return { taskId, status: 'needs_info' };
      }

      if (agentResult.status === 'failed') {
        checkCancel();
        return await failTask('running', `agent_failed: ${agentResult.reason}`);
      }

      checkCancel();

      // The verifier reads the committed diff and fails a dirty worktree, so the agent's
      // work is committed before verification, not after.
      let changed: boolean;
      try {
        await deps.sandbox.commitWorktree(
          ws,
          `harness: automated changes for task ${taskId}`
        );
        changed = await deps.sandbox.changedSince(ws, diffBaseRef);
      } catch (err) {
        throw asInfraError('commit of agent changes failed', err);
      }
      if (!changed) {
        return await failTask(
          'running',
          'agent_made_no_changes: the branch is identical to the post-install baseline'
        );
      }

      await transition('running', 'verifying', 'system');

      let verifyResult: VerifyResult;
      try {
        verifyResult = await deps.verifier.verifyTask(
          {
            id: taskId,
            repoId: task.repoId,
            title: task.title,
            description: task.description,
            worktreePath: ws.worktreePath,
            baseBranch: diffBaseRef,
            branchName: ws.branch,
            containerId,
            repo,
          },
          { workspace: { ...ws, baseBranch: diffBaseRef }, containerId },
          { db, repo, secretValues }
        );
      } catch (err) {
        throw asInfraError('verifyTask failed', err);
      }

      if (verifyResult.passed) {
        checkCancel();
        await transition('verifying', 'awaiting_approval', 'system');
        await createApproval(db, {
          id: crypto.randomUUID(),
          taskId,
          kind: 'final_diff',
          summary: maskAndTruncate(
            `Final diff ready for review: ${verifyResult.diffStats.filesChanged} file(s), ` +
              `+${verifyResult.diffStats.insertions}/-${verifyResult.diffStats.deletions}`,
            secretValues,
            MAX_FAILURE_REASON_CHARS
          ),
          payload: {
            diffStats: verifyResult.diffStats,
            flaky: verifyResult.flaky,
            // The commit the agent's diff was measured against.
            diffBaseRef,
            // verifyTask has already masked and truncated every check output.
            checks: verifyResult.checks.map((c) => ({
              name: c.name,
              passed: c.passed,
              rule: c.rule ?? null,
              reviewItem: c.reviewItem ?? false,
            })),
          },
          status: 'pending',
        });
        return { taskId, status: 'awaiting_approval' };
      }

      const failureText = describeCheckFailures(verifyResult);

      if (fixLoops >= maxVerifyFixLoops) {
        return await failTask('verifying', `verification_failed: ${failureText}`);
      }

      fixLoops++;
      checkCancel();
      await transition('verifying', 'running', 'system', { fixLoop: fixLoops });
      description =
        `${task.description}\n\n` +
        `--- Verification failed (attempt ${fixLoops} of ${maxVerifyFixLoops}) ---\n` +
        `${failureText}\n\n` +
        `Fix the cause of these failures and call finish when the checks would pass.`;
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      // The API already set 'cancelled' in Postgres; do not write a second transition.
      try {
        const current = await getTask(db, taskId);
        if (current && current.status !== 'cancelled') {
          await transitionTask(db, taskId, current.status, 'cancelled', 'system');
        }
      } catch {
        // Best effort: the task is being torn down either way.
      }
      return { taskId, status: 'cancelled' };
    }
    throw err;
  } finally {
    clearInterval(poller);
    try {
      await deps.sandbox.destroy({ containerId, workspace });
    } catch {
      // A cleanup failure must not replace the error that caused it.
    }
  }
}
