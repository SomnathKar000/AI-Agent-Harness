import { eq, and, asc } from 'drizzle-orm';
import {
  type TaskStatus,
  type AuditActor,
  canTransition,
  InvalidTransitionError,
} from '@harness/core';
import type { Database } from './client.js';
import * as schema from './schema.js';
import { ConcurrentTransitionError } from './errors.js';

export async function createRepo(
  db: Database,
  data: typeof schema.repos.$inferInsert
): Promise<typeof schema.repos.$inferSelect> {
  const [repo] = await db.insert(schema.repos).values(data).returning();
  return repo;
}

export async function createTask(
  db: Database,
  data: typeof schema.tasks.$inferInsert
): Promise<typeof schema.tasks.$inferSelect> {
  const [task] = await db.insert(schema.tasks).values(data).returning();
  return task;
}

export async function transitionTask(
  db: Database,
  taskId: string,
  expectedFrom: TaskStatus,
  to: TaskStatus,
  actor: AuditActor,
  detail?: Record<string, unknown>
): Promise<typeof schema.tasks.$inferSelect> {
  if (!canTransition(expectedFrom, to)) {
    throw new InvalidTransitionError(expectedFrom, to);
  }

  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({
        status: to,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.status, expectedFrom)
        )
      )
      .returning();

    if (updated.length === 0) {
      throw new ConcurrentTransitionError(taskId, expectedFrom, to);
    }

    await tx.insert(schema.auditLog).values({
      taskId,
      actor,
      action: 'task_transition',
      detail: {
        from: expectedFrom,
        to,
        ...(detail ?? {}),
      },
    });

    return updated[0];
  });
}

export async function appendStep(
  db: Database,
  stepData: typeof schema.taskSteps.$inferInsert
): Promise<typeof schema.taskSteps.$inferSelect> {
  const [step] = await db.insert(schema.taskSteps).values(stepData).returning();
  return step;
}

export async function createApproval(
  db: Database,
  approvalData: typeof schema.approvals.$inferInsert
): Promise<typeof schema.approvals.$inferSelect> {
  const [approval] = await db.insert(schema.approvals).values(approvalData).returning();
  return approval;
}

export async function decideApproval(
  db: Database,
  id: string,
  status: 'approved' | 'rejected',
  note?: string
): Promise<typeof schema.approvals.$inferSelect> {
  const [updated] = await db
    .update(schema.approvals)
    .set({
      status,
      note: note ?? null,
      decidedAt: new Date(),
    })
    .where(eq(schema.approvals.id, id))
    .returning();
  return updated;
}

export async function recordVerification(
  db: Database,
  verificationData: typeof schema.verifications.$inferInsert
): Promise<typeof schema.verifications.$inferSelect> {
  const [verification] = await db.insert(schema.verifications).values(verificationData).returning();
  return verification;
}

export async function appendAudit(
  db: Database,
  auditData: typeof schema.auditLog.$inferInsert
): Promise<typeof schema.auditLog.$inferSelect> {
  const [audit] = await db.insert(schema.auditLog).values(auditData).returning();
  return audit;
}

export async function getTaskWithSteps(
  db: Database,
  taskId: string
): Promise<{
  task: typeof schema.tasks.$inferSelect;
  steps: (typeof schema.taskSteps.$inferSelect)[];
} | null> {
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  if (!task) {
    return null;
  }

  const steps = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, taskId))
    .orderBy(asc(schema.taskSteps.idx));

  return { task, steps };
}
