import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@harness/db';
import { loadApiConfig } from './config.js';
import { buildServer } from './server.js';
import type { TaskQueuePort } from './queue-port.js';

/**
 * The queue name is duplicated here rather than imported from @harness/worker: the API must
 * not depend on the worker (hard rule 1). The pair is covered by
 * `packages/api/test/queue-name.test.ts`, which reads the worker's constant from disk.
 */
export const TASK_QUEUE_NAME = 'harness-tasks';

export interface QueueHandle extends TaskQueuePort {
  close(): Promise<void>;
}

export function createBullQueuePort(redisUrl: string): QueueHandle {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(TASK_QUEUE_NAME, { connection });
  return {
    async enqueue(taskId: string): Promise<void> {
      await queue.add(
        'run-task',
        { taskId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        }
      );
    },
    async close(): Promise<void> {
      await queue.close();
      await connection.quit();
    },
  };
}

export async function startApi(): Promise<{ close(): Promise<void> }> {
  const config = loadApiConfig();
  const db = createDb();
  const redisUrl = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379';
  const queue = createBullQueuePort(redisUrl);

  const app = buildServer({ db, queue, token: config.token });
  await app.listen({ host: config.host, port: config.port });

  return {
    async close(): Promise<void> {
      await app.close();
      await queue.close();
    },
  };
}
