/**
 * The API's only contact with the queue. Injected, so route tests need no Redis, and so
 * the API never imports @harness/worker (hard rule 1).
 */
export interface TaskQueuePort {
  enqueue(taskId: string): Promise<void>;
}
