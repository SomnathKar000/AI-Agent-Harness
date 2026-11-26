/**
 * Worker configuration. Only values the code actually reads live here (hard rule 16).
 */
export interface WorkerConfig {
  redisUrl: string;
  concurrency: number;
}

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const DEFAULT_CONCURRENCY = 3;

/**
 * A present-but-unparseable WORKER_CONCURRENCY throws rather than falling back to the
 * default: a typo that silently runs 3 workers instead of 1 is exactly the kind of silent
 * default hard rule 13 forbids. An absent variable takes the documented default.
 */
export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): WorkerConfig {
  const redisUrl = env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;

  const rawConcurrency = env.WORKER_CONCURRENCY?.trim();
  let concurrency = DEFAULT_CONCURRENCY;
  if (rawConcurrency !== undefined && rawConcurrency !== '') {
    const parsed = Number(rawConcurrency);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `WORKER_CONCURRENCY must be a positive integer, got '${rawConcurrency}'`
      );
    }
    concurrency = parsed;
  }

  return { redisUrl, concurrency };
}
