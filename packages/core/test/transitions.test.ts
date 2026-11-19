import { describe, it, expect } from 'vitest';
import {
  canTransition,
  ALL_STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  type TaskStatus,
  TaskSchema,
  StepSchema,
  ApprovalSchema,
  VerificationSchema,
  AuditLogSchema,
} from '../src/index.js';

describe('Task State Machine (packages/core)', () => {
  it('allows all defined forward and extra transitions', () => {
    // Normal progression: queued -> running -> verifying -> awaiting_approval -> pushing -> done
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'pushing')).toBe(true);
    expect(canTransition('pushing', 'done')).toBe(true);

    // Extra: running -> needs_info -> running
    expect(canTransition('running', 'needs_info')).toBe(true);
    expect(canTransition('needs_info', 'running')).toBe(true);

    // Any non-terminal can transition to failed or cancelled
    const nonTerminals = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s as any));
    for (const status of nonTerminals) {
      expect(canTransition(status, 'failed')).toBe(true);
      expect(canTransition(status, 'cancelled')).toBe(true);
    }
  });

  it('disallows every invalid transition', () => {
    for (const from of ALL_STATUSES) {
      const allowed = ALLOWED_TRANSITIONS[from];
      for (const to of ALL_STATUSES) {
        if (!allowed.includes(to)) {
          expect(canTransition(from, to)).toBe(false);
        }
      }
    }
  });

  it('ensures terminal states have no outgoing transitions', () => {
    for (const term of TERMINAL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[term]).toEqual([]);
      for (const target of ALL_STATUSES) {
        expect(canTransition(term, target)).toBe(false);
      }
    }
  });

  it('ensures every TaskStatus is reachable from queued', () => {
    const visited = new Set<TaskStatus>(['queued']);
    const queue: TaskStatus[] = ['queued'];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const nextStates = ALLOWED_TRANSITIONS[current];
      for (const next of nextStates) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    // Every status in ALL_STATUSES must be visited
    for (const status of ALL_STATUSES) {
      expect(visited.has(status)).toBe(true);
    }
    expect(visited.size).toBe(ALL_STATUSES.length);
  });
});

describe('Zod Schemas Validation (packages/core)', () => {
  it('validates Task schema', () => {
    const valid = TaskSchema.parse({
      id: 'task-1',
      repoId: 'repo-1',
      title: 'Fix issue',
      description: 'Bug description',
      status: 'queued',
      attempt: 1,
      maxSteps: 40,
      maxCostUsd: 2.0,
      maxMinutes: 30,
    });
    expect(valid.status).toBe('queued');
    expect(valid.maxSteps).toBe(40);
  });

  it('validates Step schema', () => {
    const step = StepSchema.parse({
      id: 'step-1',
      taskId: 'task-1',
      idx: 0,
      kind: 'tool_call',
      toolName: 'readFile',
      input: { path: 'src/index.ts' },
      output: { content: 'hello' },
      decision: 'allow',
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.005,
    });
    expect(step.kind).toBe('tool_call');
    expect(step.decision).toBe('allow');
  });

  it('validates Approval schema', () => {
    const approval = ApprovalSchema.parse({
      id: 'app-1',
      taskId: 'task-1',
      kind: 'push',
      summary: 'Approve PR push',
      status: 'pending',
    });
    expect(approval.status).toBe('pending');
  });

  it('validates Verification schema', () => {
    const v = VerificationSchema.parse({
      id: 'v-1',
      taskId: 'task-1',
      check: 'test',
      passed: true,
      output: 'all passed',
    });
    expect(v.passed).toBe(true);
  });

  it('validates AuditLog schema', () => {
    const audit = AuditLogSchema.parse({
      id: 1,
      taskId: 'task-1',
      actor: 'system',
      action: 'task_transition',
      detail: { from: 'queued', to: 'running' },
    });
    expect(audit.actor).toBe('system');
  });
});
