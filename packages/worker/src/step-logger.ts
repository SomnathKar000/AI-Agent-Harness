import crypto from 'node:crypto';
import { appendStep, type Database } from '@harness/db';
import type { StepLogger, LogStepParams } from '@harness/agent';

/**
 * The single writer for `task_steps` (hard rule 15). The agent loop calls `logStep`; nothing
 * else in the worker touches the table.
 *
 * Values arrive already masked and truncated: the agent loop runs `maskAndTruncateValue`
 * over every field before calling the logger (hard rule 14).
 *
 * `idx` is per agent run and restarts at 1, so a verify-fix round would collide with the
 * first run. `beginRun()` shifts the base so indices stay monotonic across rounds.
 */
export interface RunStepLogger extends StepLogger {
  beginRun(): void;
}

export function createDbStepLogger(db: Database): RunStepLogger {
  let offset = 0;
  let maxIdx = 0;

  return {
    beginRun(): void {
      offset = maxIdx;
    },
    async logStep(params: LogStepParams): Promise<void> {
      const idx = offset + params.idx;
      if (idx > maxIdx) {
        maxIdx = idx;
      }
      await appendStep(db, {
        id: crypto.randomUUID(),
        taskId: params.taskId,
        idx,
        kind: params.kind,
        toolName: params.toolName ?? null,
        input: (params.input ?? null) as never,
        output: (params.output ?? null) as never,
        decision: params.decision ?? null,
        promptTokens: params.promptTokens ?? 0,
        completionTokens: params.completionTokens ?? 0,
        costUsd: (params.costUsd ?? 0).toFixed(4),
      });
    },
  };
}
