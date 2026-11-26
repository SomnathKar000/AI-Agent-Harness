import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@harness/db';
import { getTask, transitionTask, appendStep, recordVerification } from '@harness/db';
import crypto from 'node:crypto';
import {
  setupTestDb,
  buildTestServer,
  auth,
  seedRepo,
  seedTask,
  type TestServer,
} from './helpers.js';

describe('Task routes', () => {
  let db: Database;
  let server: TestServer;
  let repoId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    server = await buildTestServer(db);
    repoId = await seedRepo(db);
  });

  afterAll(async () => {
    await server?.close();
  });

  it('creates a queued task and enqueues exactly one job', async () => {
    const before = server.enqueued.length;
    const res = await server.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: auth(),
      payload: { repoId, title: 'Login loop', description: 'Redirect loops after logout' },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json();
    expect(task.status).toBe('queued');
    expect(server.enqueued.length).toBe(before + 1);
    expect(server.enqueued[server.enqueued.length - 1]).toBe(task.id);
  });

  it('does not enqueue anything when the repo does not exist', async () => {
    const before = server.enqueued.length;
    const res = await server.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: auth(),
      payload: { repoId: 'no-such-repo', title: 't', description: 'd' },
    });
    expect(res.statusCode).toBe(404);
    expect(server.enqueued.length).toBe(before);
  });

  it.each([
    ['an empty body', {}],
    ['a missing description', { repoId: 'r', title: 't' }],
    ['an empty title', { repoId: 'r', title: '  ', description: 'd' }],
    ['an unknown field', { repoId: 'r', title: 't', description: 'd', status: 'done' }],
    ['a negative maxSteps', { repoId: 'r', title: 't', description: 'd', maxSteps: -1 }],
  ])('rejects %s with 400 and enqueues nothing', async (_label, payload) => {
    const before = server.enqueued.length;
    const res = await server.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: auth(),
      payload: payload as never,
    });
    expect(res.statusCode).toBe(400);
    expect(server.enqueued.length).toBe(before);
  });

  it('refuses to let a client set the status on creation', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: auth(),
      payload: { repoId, title: 't', description: 'd', status: 'done' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns steps, verifications, approvals and cost totals', async () => {
    const taskId = await seedTask(db, repoId);
    await appendStep(db, {
      id: crypto.randomUUID(),
      taskId,
      idx: 1,
      kind: 'llm_call',
      promptTokens: 100,
      completionTokens: 50,
      costUsd: '0.1234',
    });
    await appendStep(db, {
      id: crypto.randomUUID(),
      taskId,
      idx: 2,
      kind: 'tool_call',
      toolName: 'read_file',
      decision: 'allow',
      costUsd: '0.0100',
    });
    await recordVerification(db, {
      id: crypto.randomUUID(),
      taskId,
      check: 'test',
      passed: true,
      output: 'ok',
    });

    const res = await server.app.inject({
      method: 'GET',
      url: `/tasks/${taskId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.task.id).toBe(taskId);
    expect(body.steps.length).toBe(2);
    expect(body.verifications.length).toBe(1);
    expect(body.cost.costUsd).toBeCloseTo(0.1334, 4);
    expect(body.cost.promptTokens).toBe(100);
    expect(body.cost.completionTokens).toBe(50);
  });

  it('404s an unknown task', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/tasks/nope',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('filters the list by status', async () => {
    const failedId = await seedTask(db, repoId);
    await transitionTask(db, failedId, 'queued', 'failed', 'system');

    const res = await server.app.inject({
      method: 'GET',
      url: '/tasks?status=failed',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const tasks = res.json().tasks as { id: string; status: string }[];
    expect(tasks.every((t) => t.status === 'failed')).toBe(true);
    expect(tasks.some((t) => t.id === failedId)).toBe(true);
  });

  it('rejects an unknown status filter with 400', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/tasks?status=banana',
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('cancels a queued task', async () => {
    const taskId = await seedTask(db, repoId);
    const res = await server.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/cancel`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect((await getTask(db, taskId))?.status).toBe('cancelled');
  });

  it('cancels a running task', async () => {
    const taskId = await seedTask(db, repoId);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    const res = await server.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/cancel`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect((await getTask(db, taskId))?.status).toBe('cancelled');
  });

  it('409s rather than 500s when cancelling an already-cancelled task', async () => {
    const taskId = await seedTask(db, repoId);
    await transitionTask(db, taskId, 'queued', 'cancelled', 'human');
    const res = await server.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/cancel`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
  });

  it('retry moves a failed task back to queued, increments attempt and re-enqueues', async () => {
    const taskId = await seedTask(db, repoId);
    await transitionTask(db, taskId, 'queued', 'failed', 'system');
    const attemptBefore = (await getTask(db, taskId))!.attempt;
    const enqueuedBefore = server.enqueued.length;

    const res = await server.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/retry`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const after = await getTask(db, taskId);
    expect(after?.status).toBe('queued');
    expect(after?.attempt).toBe(attemptBefore + 1);
    expect(after?.failureReason).toBeNull();
    expect(server.enqueued.length).toBe(enqueuedBefore + 1);
    expect(server.enqueued[server.enqueued.length - 1]).toBe(taskId);
  });

  it('409s a retry of a task that is not failed, and enqueues nothing', async () => {
    const taskId = await seedTask(db, repoId);
    const before = server.enqueued.length;
    const res = await server.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/retry`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
    expect(server.enqueued.length).toBe(before);
  });

  it('404s a retry of an unknown task', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/tasks/no-such-task/retry',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
