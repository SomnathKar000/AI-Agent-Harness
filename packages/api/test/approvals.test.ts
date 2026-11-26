import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { Database } from '@harness/db';
import { createApproval, getApproval, auditLog, eq, asc } from '@harness/db';
import {
  setupTestDb,
  buildTestServer,
  auth,
  seedRepo,
  seedTask,
  type TestServer,
} from './helpers.js';

describe('Approval routes', () => {
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

  async function seedApproval(taskId: string): Promise<string> {
    const id = crypto.randomUUID();
    await createApproval(db, {
      id,
      taskId,
      kind: 'final_diff',
      summary: 'Final diff ready',
      payload: { diffStats: { insertions: 1, deletions: 1 } },
      status: 'pending',
    });
    return id;
  }

  it('lists pending approvals', async () => {
    const taskId = await seedTask(db, repoId);
    const approvalId = await seedApproval(taskId);

    const res = await server.app.inject({
      method: 'GET',
      url: '/approvals?status=pending',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const approvals = res.json().approvals as { id: string; status: string }[];
    expect(approvals.some((a) => a.id === approvalId)).toBe(true);
    expect(approvals.every((a) => a.status === 'pending')).toBe(true);
  });

  it('approves and writes an audit row with actor human', async () => {
    const taskId = await seedTask(db, repoId);
    const approvalId = await seedApproval(taskId);

    const res = await server.app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: auth(),
      payload: { approved: true, note: 'looks right' },
    });
    expect(res.statusCode).toBe(200);

    const stored = await getApproval(db, approvalId);
    expect(stored?.status).toBe('approved');
    expect(stored?.note).toBe('looks right');
    expect(stored?.decidedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.taskId, taskId))
      .orderBy(asc(auditLog.id));
    const decided = audits.filter((a) => a.action === 'approval_decided');
    expect(decided.length).toBe(1);
    expect(decided[0].actor).toBe('human');
    expect((decided[0].detail as { decision: string }).decision).toBe('approved');
  });

  it('rejects with a note', async () => {
    const taskId = await seedTask(db, repoId);
    const approvalId = await seedApproval(taskId);

    const res = await server.app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: auth(),
      payload: { approved: false, note: 'wrong fix' },
    });
    expect(res.statusCode).toBe(200);
    expect((await getApproval(db, approvalId))?.status).toBe('rejected');
  });

  it('409s a second decision on the same approval', async () => {
    const taskId = await seedTask(db, repoId);
    const approvalId = await seedApproval(taskId);

    await server.app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: auth(),
      payload: { approved: true },
    });
    const second = await server.app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: auth(),
      payload: { approved: false },
    });
    expect(second.statusCode).toBe(409);
  });

  it.each([
    ['an empty body', {}],
    ['a non-boolean approved', { approved: 'yes' }],
    ['an unknown field', { approved: true, rogue: 1 }],
  ])('rejects %s with 400', async (_label, payload) => {
    const taskId = await seedTask(db, repoId);
    const approvalId = await seedApproval(taskId);
    const res = await server.app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: auth(),
      payload: payload as never,
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown approval', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/approvals/no-such-approval/decide',
      headers: auth(),
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('truncates an oversized note before it reaches the database (hard rule 14)', async () => {
    const taskId = await seedTask(db, repoId);
    const approvalId = await seedApproval(taskId);
    const longNote = 'x'.repeat(1999);

    const res = await server.app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: auth(),
      payload: { approved: true, note: longNote },
    });
    expect(res.statusCode).toBe(200);
    const stored = await getApproval(db, approvalId);
    expect(stored!.note!.length).toBeLessThanOrEqual(2100);
  });

  it('rejects a note longer than the schema allows with 400', async () => {
    const taskId = await seedTask(db, repoId);
    const approvalId = await seedApproval(taskId);
    const res = await server.app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: auth(),
      payload: { approved: true, note: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(400);
  });
});
