/**
 * Infrastructure failure: Docker, Postgres, Redis, git plumbing. The BullMQ processor
 * rethrows these so the job is retried.
 */
export class InfraError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown
  ) {
    super(message);
    this.name = 'InfraError';
  }
}

/**
 * The task was cancelled while the pipeline was running. Not an error to retry: the
 * pipeline unwinds, cleans up and resolves.
 */
export class CancelledError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task '${taskId}' was cancelled`);
    this.name = 'CancelledError';
  }
}

/** Wraps anything thrown by an infrastructure call, preserving the original message. */
export function asInfraError(context: string, err: unknown): InfraError {
  const message = err instanceof Error ? err.message : String(err);
  return new InfraError(`${context}: ${message}`, err);
}
