import { eq, and, asc, desc, gt, inArray } from 'drizzle-orm';
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

// ---------------------------------------------------------------------------
// Phase 6 read side.
//
// The API reads through these; route handlers hold no query logic (hard rule 1).
// None of them writes `tasks.status` — status moves only through transitionTask
// (hard rule 9), and none of them writes task_steps (hard rule 15).
// ---------------------------------------------------------------------------

export async function getRepo(
  db: Database,
  repoId: string
): Promise<typeof schema.repos.$inferSelect | null> {
  const [repo] = await db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, repoId))
    .limit(1);
  return repo ?? null;
}

export async function listRepos(
  db: Database
): Promise<(typeof schema.repos.$inferSelect)[]> {
  return await db.select().from(schema.repos).orderBy(asc(schema.repos.createdAt));
}

export async function getTask(
  db: Database,
  taskId: string
): Promise<typeof schema.tasks.$inferSelect | null> {
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  return task ?? null;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  limit?: number;
}

export async function listTasks(
  db: Database,
  options?: ListTasksOptions
): Promise<(typeof schema.tasks.$inferSelect)[]> {
  // An explicit limit of 0 means 0, not "unlimited": only `undefined` takes the default.
  const limit = options?.limit ?? 100;
  const base = db.select().from(schema.tasks);
  const filtered = options?.status
    ? base.where(eq(schema.tasks.status, options.status))
    : base;
  return await filtered.orderBy(desc(schema.tasks.createdAt)).limit(limit);
}

export async function findTasksByStatus(
  db: Database,
  statuses: readonly TaskStatus[]
): Promise<(typeof schema.tasks.$inferSelect)[]> {
  // An empty status list matches nothing. inArray([]) is a SQL error in some drivers, and
  // "no filter" would mean every task, which is the opposite of what an empty list asks for.
  if (statuses.length === 0) {
    return [];
  }
  return await db
    .select()
    .from(schema.tasks)
    .where(inArray(schema.tasks.status, [...statuses]))
    .orderBy(asc(schema.tasks.createdAt));
}

export async function getStepsAfter(
  db: Database,
  taskId: string,
  afterIdx: number
): Promise<(typeof schema.taskSteps.$inferSelect)[]> {
  return await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, taskId), gt(schema.taskSteps.idx, afterIdx)))
    .orderBy(asc(schema.taskSteps.idx));
}

export interface CostTotals {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface TaskDetail {
  task: typeof schema.tasks.$inferSelect;
  steps: (typeof schema.taskSteps.$inferSelect)[];
  verifications: (typeof schema.verifications.$inferSelect)[];
  approvals: (typeof schema.approvals.$inferSelect)[];
  cost: CostTotals;
}

export async function getTaskDetail(
  db: Database,
  taskId: string
): Promise<TaskDetail | null> {
  const task = await getTask(db, taskId);
  if (!task) {
    return null;
  }

  const [steps, taskVerifications, taskApprovals] = await Promise.all([
    db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(asc(schema.taskSteps.idx)),
    db
      .select()
      .from(schema.verifications)
      .where(eq(schema.verifications.taskId, taskId))
      .orderBy(asc(schema.verifications.createdAt)),
    db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.taskId, taskId))
      .orderBy(asc(schema.approvals.createdAt)),
  ]);

  const cost: CostTotals = {
    costUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
  for (const step of steps) {
    // cost_usd is numeric(10,4); the driver hands it back as a string.
    const parsed = Number(step.costUsd);
    cost.costUsd += Number.isFinite(parsed) ? parsed : 0;
    cost.promptTokens += step.promptTokens;
    cost.completionTokens += step.completionTokens;
  }
  // Keep the numeric(10,4) precision of the column rather than a float tail.
  cost.costUsd = Number(cost.costUsd.toFixed(4));

  return { task, steps, verifications: taskVerifications, approvals: taskApprovals, cost };
}

export interface ListApprovalsOptions {
  status?: 'pending' | 'approved' | 'rejected';
  taskId?: string;
  limit?: number;
}

export async function listApprovals(
  db: Database,
  options?: ListApprovalsOptions
): Promise<(typeof schema.approvals.$inferSelect)[]> {
  const limit = options?.limit ?? 100;
  const conditions = [];
  if (options?.status) {
    conditions.push(eq(schema.approvals.status, options.status));
  }
  if (options?.taskId) {
    conditions.push(eq(schema.approvals.taskId, options.taskId));
  }
  const base = db.select().from(schema.approvals);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return await filtered.orderBy(asc(schema.approvals.createdAt)).limit(limit);
}

export async function getApproval(
  db: Database,
  approvalId: string
): Promise<typeof schema.approvals.$inferSelect | null> {
  const [approval] = await db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId))
    .limit(1);
  return approval ?? null;
}

/**
 * Updates the bookkeeping columns on a task. Deliberately cannot set `status`:
 * every status change goes through transitionTask's compare-and-set (hard rule 9).
 * An empty patch is a no-op rather than an UPDATE with no SET clause.
 */
export interface TaskFieldPatch {
  branchName?: string | null;
  worktreePath?: string | null;
  containerId?: string | null;
  failureReason?: string | null;
  attempt?: number;
  prUrl?: string | null;
}

export async function setTaskFields(
  db: Database,
  taskId: string,
  patch: TaskFieldPatch
): Promise<typeof schema.tasks.$inferSelect | null> {
  const update: Record<string, unknown> = {};
  if ('branchName' in patch) update.branchName = patch.branchName;
  if ('worktreePath' in patch) update.worktreePath = patch.worktreePath;
  if ('containerId' in patch) update.containerId = patch.containerId;
  if ('failureReason' in patch) update.failureReason = patch.failureReason;
  if ('attempt' in patch) update.attempt = patch.attempt;
  if ('prUrl' in patch) update.prUrl = patch.prUrl;

  if (Object.keys(update).length === 0) {
    return await getTask(db, taskId);
  }

  update.updatedAt = new Date();

  const [updated] = await db
    .update(schema.tasks)
    .set(update)
    .where(eq(schema.tasks.id, taskId))
    .returning();
  return updated ?? null;
}
