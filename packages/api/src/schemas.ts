import { z } from 'zod';
import { TaskStatusSchema } from '@harness/core';

const nonEmpty = z.string().trim().min(1);

export const CreateRepoBodySchema = z
  .object({
    id: nonEmpty.optional(),
    name: nonEmpty,
    localPath: nonEmpty,
    defaultBranch: nonEmpty.default('main'),
    githubOwner: nonEmpty.optional(),
    githubRepo: nonEmpty.optional(),
    testCommand: nonEmpty.optional(),
    lintCommand: nonEmpty.optional(),
    typecheckCommand: nonEmpty.optional(),
    installCommand: nonEmpty.optional(),
  })
  .strict();

export const CreateTaskBodySchema = z
  .object({
    repoId: nonEmpty,
    title: nonEmpty,
    description: nonEmpty,
    type: nonEmpty.default('bugfix'),
    maxSteps: z.number().int().positive().max(500).optional(),
    maxCostUsd: z.number().positive().max(1000).optional(),
    maxMinutes: z.number().int().positive().max(720).optional(),
  })
  .strict();

export const TaskIdParamsSchema = z.object({ id: nonEmpty }).strict();
export const ApprovalIdParamsSchema = z.object({ id: nonEmpty }).strict();

export const ListTasksQuerySchema = z
  .object({
    status: TaskStatusSchema.optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

export const ListApprovalsQuerySchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    taskId: nonEmpty.optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

export const DecideApprovalBodySchema = z
  .object({
    approved: z.boolean(),
    note: z.string().max(2000).optional(),
  })
  .strict();

export type CreateRepoBody = z.infer<typeof CreateRepoBodySchema>;
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;
export type DecideApprovalBody = z.infer<typeof DecideApprovalBodySchema>;
