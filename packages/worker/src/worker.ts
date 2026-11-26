import { Worker, type Job } from 'bullmq';
import { createDb, type Database } from '@harness/db';
import { ClaudeClient, type LLMClient } from '@harness/agent';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import {
  TASK_QUEUE_NAME,
  createRedisConnection,
  parseTaskJob,
  type TaskJob,
} from './queue.js';
import { runTaskPipeline, type PipelineDeps, type PipelineOutcome } from './pipeline.js';
import { reconcileOrphans, defaultReconcilePorts } from './reconcile.js';
import { InfraError } from './errors.js';
import {
  defaultSandbox,
  defaultAgent,
  defaultVerifier,
  defaultCreateGate,
} from './ports.js';

export interface StartWorkerOptions {
  db?: Database;
  llm?: LLMClient;
  config?: WorkerConfig;
  /** Overrides for tests; production uses the real ports. */
  pipelineDeps?: Partial<PipelineDeps>;
}

export interface RunningWorker {
  worker: Worker<TaskJob>;
  close(): Promise<void>;
}

/**
 * Builds the processor BullMQ runs per job.
 *
 * Only InfraError escapes. Every other outcome — a failed agent, a failed verification, a
 * cancelled task — resolves, so BullMQ's retry applies to infrastructure and nothing else.
 */
export function createJobProcessor(
  deps: PipelineDeps
): (job: Job<TaskJob>) => Promise<PipelineOutcome> {
  return async (job: Job<TaskJob>): Promise<PipelineOutcome> => {
    // The payload is validated, never defaulted (hard rule 13).
    const { taskId } = parseTaskJob(job.data);
    return await runTaskPipeline(taskId, deps);
  };
}

export async function startWorker(
  options?: StartWorkerOptions
): Promise<RunningWorker> {
  const config = options?.config ?? loadWorkerConfig();
  const db = options?.db ?? createDb();

  // The Anthropic key lives in this host process and nowhere else (hard rule 4).
  const llm = options?.llm ?? new ClaudeClient();

  const deps: PipelineDeps = {
    db,
    sandbox: defaultSandbox,
    agent: defaultAgent,
    verifier: defaultVerifier,
    createGate: defaultCreateGate,
    llm,
    ...(options?.pipelineDeps ?? {}),
  };

  // Clean up after a crashed run before accepting new work.
  const report = await reconcileOrphans(defaultReconcilePorts(db));
  if (
    report.failedTaskIds.length > 0 ||
    report.removedContainerIds.length > 0 ||
    report.removedWorktreePaths.length > 0 ||
    report.errors.length > 0
  ) {
    console.log(
      `[worker] reconciled on startup: ${report.failedTaskIds.length} task(s) failed, ` +
        `${report.removedContainerIds.length} container(s) removed, ` +
        `${report.removedWorktreePaths.length} worktree(s) removed, ` +
        `${report.errors.length} error(s)`
    );
    for (const err of report.errors) {
      console.error(`[worker] reconcile: ${err}`);
    }
  }

  const connection = createRedisConnection(config.redisUrl);
  const worker = new Worker<TaskJob>(TASK_QUEUE_NAME, createJobProcessor(deps), {
    connection,
    concurrency: config.concurrency,
  });

  worker.on('failed', (job, err) => {
    const retryable = err instanceof InfraError;
    console.error(
      `[worker] job ${job?.id ?? '?'} failed (${retryable ? 'infra, will retry' : 'not retryable'}): ${err.message}`
    );
  });

  return {
    worker,
    async close(): Promise<void> {
      await worker.close();
      await connection.quit();
    },
  };
}
