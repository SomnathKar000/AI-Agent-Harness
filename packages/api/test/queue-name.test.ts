import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TASK_QUEUE_NAME } from '../src/start.js';

/**
 * The API must not import @harness/worker (hard rule 1), so the queue name is written out
 * twice. A mismatch would mean the API enqueues jobs no worker ever reads, with no error
 * anywhere — this reads the worker's source from disk to keep the two honest.
 */
describe('Queue name agrees with the worker', () => {
  it('matches the constant in packages/worker/src/queue.ts', () => {
    const workerQueueSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../worker/src/queue.ts'),
      'utf8'
    );
    const match = workerQueueSrc.match(/TASK_QUEUE_NAME\s*=\s*'([^']+)'/);
    expect(match).not.toBeNull();
    expect(TASK_QUEUE_NAME).toBe(match![1]);
  });
});
