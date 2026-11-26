import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * Redis/BullMQ dispatches jobs and nothing else. Postgres stays the source of truth for
 * task state (hard rule 9), so a job carries an id and no state.
 */
export const TASK_QUEUE_NAME = 'harness-tasks';

export const TaskJobSchema = z
  .object({
    taskId: z.string().trim().min(1),
  })
  .strict();

export type TaskJob = z.infer<typeof TaskJobSchema>;

/** Throws on a malformed payload rather than defaulting any field (hard rule 13). */
export function parseTaskJob(data: unknown): TaskJob {
  return TaskJobSchema.parse(data);
}

export function createRedisConnection(redisUrl: string): Redis {
  // BullMQ requires maxRetriesPerRequest: null on the connection it blocks on.
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createTaskQueue(connection: Redis): Queue<TaskJob> {
  return new Queue<TaskJob>(TASK_QUEUE_NAME, { connection });
}

/**
 * Retries are for infrastructure failures; the pipeline only throws for those. Agent and
 * verification failures resolve, so they never reach this count.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
};

export async function enqueueTask(
  queue: Queue<TaskJob>,
  taskId: string,
  options?: JobsOptions
): Promise<void> {
  const job = parseTaskJob({ taskId });
  await queue.add('run-task', job, { ...DEFAULT_JOB_OPTIONS, ...(options ?? {}) });
}
