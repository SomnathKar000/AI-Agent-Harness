import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { Database } from '@harness/db';
import { appendStep, transitionTask } from '@harness/db';
import {
  setupTestDb,
  buildTestServer,
  auth,
  seedRepo,
  seedTask,
  type TestServer,
} from './helpers.js';

function parseEvents(body: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  for (const chunk of body.split('\n\n')) {
    const eventLine = chunk.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine && dataLine) {
      out.push({
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      });
    }
  }
  return out;
}

describe('Task log stream', () => {
  let db: Database;
  let server: TestServer;
  let repoId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    server = await buildTestServer(db, { logsPollMs: 20, logsMaxDurationMs: 5000 });
    repoId = await seedRepo(db);
  });

  afterAll(async () => {
    await server?.close();
  });

  it('streams existing steps, the status, and ends on a terminal status', async () => {
    const taskId = await seedTask(db, repoId);
    await appendStep(db, {
      id: crypto.randomUUID(),
      taskId,
      idx: 1,
      kind: 'llm_call',
      promptTokens: 10,
      completionTokens: 5,
      costUsd: '0.0010',
    });
    await transitionTask(db, taskId, 'queued', 'cancelled', 'human');

    const res = await server.app.inject({
      method: 'GET',
      url: `/tasks/${taskId}/logs`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseEvents(res.body);
    expect(events.some((e) => e.event === 'step')).toBe(true);
    expect(events.some((e) => e.event === 'status')).toBe(true);
    const end = events.find((e) => e.event === 'end');
    expect(end).toBeDefined();
    expect((end!.data as { status: string }).status).toBe('cancelled');
  });

  it('ends on awaiting_approval, where the task waits for a human not the worker', async () => {
    const taskId = await seedTask(db, repoId);
    await transitionTask(db, taskId, 'queued', 'running', 'system');
    await transitionTask(db, taskId, 'running', 'verifying', 'system');
    await transitionTask(db, taskId, 'verifying', 'awaiting_approval', 'system');

    const res = await server.app.inject({
      method: 'GET',
      url: `/tasks/${taskId}/logs`,
      headers: auth(),
    });

    const events = parseEvents(res.body);
    const end = events.find((e) => e.event === 'end');
    expect((end!.data as { status: string }).status).toBe('awaiting_approval');
  });

  it('reports a status change that happens while the stream is open', async () => {
    const taskId = await seedTask(db, repoId);
    await transitionTask(db, taskId, 'queued', 'running', 'system');

    const streaming = server.app.inject({
      method: 'GET',
      url: `/tasks/${taskId}/logs`,
      headers: auth(),
    });

    setTimeout(() => {
      void transitionTask(db, taskId, 'running', 'failed', 'system');
    }, 120);

    const res = await streaming;
    const events = parseEvents(res.body);
    const statuses = events
      .filter((e) => e.event === 'status')
      .map((e) => (e.data as { status: string }).status);
    expect(statuses[0]).toBe('running');
    expect(statuses).toContain('failed');
  });

  it('404s an unknown task without opening a stream', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/tasks/no-such-task/logs',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('stops at the duration ceiling rather than streaming forever', async () => {
    const taskId = await seedTask(db, repoId);
    await transitionTask(db, taskId, 'queued', 'running', 'system');

    const short = await buildTestServer(db, { logsPollMs: 20, logsMaxDurationMs: 100 });
    try {
      const res = await short.app.inject({
        method: 'GET',
        url: `/tasks/${taskId}/logs`,
        headers: auth(),
      });
      const end = parseEvents(res.body).find((e) => e.event === 'end');
      expect((end!.data as { reason?: string }).reason).toBe('stream_timeout');
    } finally {
      await short.close();
    }
  });
});
