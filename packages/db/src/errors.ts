export class ConcurrentTransitionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly expectedFrom: string,
    public readonly to: string
  ) {
    super(
      `Concurrent transition conflict for task '${taskId}': expected status '${expectedFrom}' when transitioning to '${to}'`
    );
    this.name = 'ConcurrentTransitionError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task '${taskId}' not found`);
    this.name = 'TaskNotFoundError';
  }
}
