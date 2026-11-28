import {
  ConcurrentTransitionError,
  decideApproval,
  getApproval,
  getTask,
  listApprovals,
  transitionTask,
  type Database,
} from '@harness/db';
import type { ApprovalOutcome, ApprovalRequest, ApprovalWaiter } from '@harness/agent';
import { CancelledError } from './errors.js';

export const DEFAULT_APPROVAL_POLL_MS = 2000;
/** Half an hour. A human who has not answered by then gets a denial, not an allow. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

export interface ApprovalWaiterOptions {
  db: Database;
  taskId: string;
  pollMs?: number;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * The row the policy gate wrote just before it returned `ask`. Newest wins: a run can
 * ask more than once, and only the latest one belongs to this tool call.
 */
async function newestPendingToolCall(db: Database, taskId: string) {
  const rows = await listApprovals(db, { taskId, status: 'pending' });
  const toolCalls = rows.filter((r) => r.kind === 'tool_call');
  return toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : undefined;
}

/**
 * Waits for a human to decide a mid-run tool approval, driving running -> paused ->
 * running around the wait.
 *
 * Fails closed throughout (hard rule 13): a missing row, a failed pause, a timeout or an
 * unreadable approval all resolve to `rejected`. The one thing that does not resolve is a
 * cancel, which throws `CancelledError` so the pipeline tears the run down.
 *
 * Every status change goes through `transitionTask` (hard rule 9). This writes no
 * `task_steps` row; the agent loop remains the only writer (hard rule 15).
 */
export function createDbApprovalWaiter(options: ApprovalWaiterOptions): ApprovalWaiter {
  const { db, taskId } = options;
  const pollMs = options.pollMs ?? DEFAULT_APPROVAL_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  const assertNotCancelled = async (): Promise<'paused' | 'gone'> => {
    const task = await getTask(db, taskId);
    if (!task || task.status === 'cancelled') throw new CancelledError(taskId);
    return task.status === 'paused' ? 'paused' : 'gone';
  };

  return {
    async waitForApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
      const row = await newestPendingToolCall(db, taskId);
      if (!row) {
        return {
          status: 'rejected',
          reason: `no pending approval row for tool '${request.toolCall.name}'`,
        };
      }

      try {
        await transitionTask(db, taskId, 'running', 'paused', 'agent', {
          approvalId: row.id,
          toolName: request.toolCall.name,
        });
      } catch (err) {
        if (err instanceof ConcurrentTransitionError) {
          const current = await getTask(db, taskId).catch(() => null);
          if (current?.status === 'cancelled') throw new CancelledError(taskId);
        }
        return {
          status: 'rejected',
          reason: `could not pause the task to ask for approval: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const deadline = Date.now() + timeoutMs;
      let outcome: ApprovalOutcome;
      let resume = true;

      for (;;) {
        const taskState = await assertNotCancelled();
        if (taskState === 'gone') {
          // Something else moved the task out of `paused` (a reconcile sweep, say).
          // Do not fight it, and do not transition back.
          outcome = { status: 'rejected', reason: 'task left the paused state while waiting' };
          resume = false;
          break;
        }

        const current = await getApproval(db, row.id);
        if (current && current.status !== 'pending') {
          outcome =
            current.status === 'approved'
              ? { status: 'approved', note: current.note ?? undefined }
              : {
                  status: 'rejected',
                  reason: current.note
                    ? `rejected by human: ${current.note}`
                    : 'rejected by human',
                };
          break;
        }

        if (Date.now() >= deadline) {
          // Leave no pending row behind for someone to answer after the fact.
          await decideApproval(
            db,
            row.id,
            'rejected',
            `no human decision within ${timeoutMs}ms`
          ).catch(() => undefined);
          outcome = { status: 'rejected', reason: `approval timed out after ${timeoutMs}ms` };
          break;
        }

        await sleep(pollMs);
      }

      if (resume) {
        try {
          await transitionTask(db, taskId, 'paused', 'running', 'system', {
            approvalId: row.id,
            decision: outcome.status,
          });
        } catch (err) {
          if (err instanceof ConcurrentTransitionError) {
            const current = await getTask(db, taskId).catch(() => null);
            if (current?.status === 'cancelled') throw new CancelledError(taskId);
          }
          throw err;
        }
      }

      return outcome;
    },
  };
}
