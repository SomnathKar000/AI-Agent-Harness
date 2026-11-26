import { describe, it, expect } from 'vitest';
import { TASK_QUEUE_NAME, TaskJobSchema, parseTaskJob } from '../src/queue.js';

describe('Task queue job payloads fail closed', () => {
  it('has a stable queue name', () => {
    expect(TASK_QUEUE_NAME).toBe('harness-tasks');
  });

  it('accepts a well formed job', () => {
    expect(TaskJobSchema.safeParse({ taskId: 'task-1' }).success).toBe(true);
  });

  it.each([
    ['empty object', {}],
    ['numeric taskId', { taskId: 1 }],
    ['null taskId', { taskId: null }],
    ['empty taskId', { taskId: '' }],
    ['whitespace taskId', { taskId: '   ' }],
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'task-1'],
    ['extra keys', { taskId: 'task-1', command: 'rm -rf /' }],
  ])('rejects %s', (_label, payload) => {
    expect(TaskJobSchema.safeParse(payload).success).toBe(false);
  });

  it('parseTaskJob throws rather than defaulting a missing taskId', () => {
    expect(() => parseTaskJob({})).toThrow();
    expect(() => parseTaskJob({ taskId: 'task-1' })).not.toThrow();
  });
});
