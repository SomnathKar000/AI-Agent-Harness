import { TaskStatus, TaskStatusSchema } from './types.js';

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'done',
  'failed',
  'cancelled',
] as const;

export const ALL_STATUSES: readonly TaskStatus[] = TaskStatusSchema.options;

/**
 * State machine allowed transitions:
 * queued -> running -> verifying -> awaiting_approval -> pushing -> done.
 * Extra: running -> needs_info -> running; any non-terminal -> failed | cancelled.
 * Terminal: done, failed, cancelled (no outgoing transitions).
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['verifying', 'needs_info', 'failed', 'cancelled'],
  needs_info: ['running', 'failed', 'cancelled'],
  verifying: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['pushing', 'failed', 'cancelled'],
  pushing: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus
  ) {
    super(`Cannot transition task from '${from}' to '${to}'`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Pure function returning whether a state transition is allowed.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}
