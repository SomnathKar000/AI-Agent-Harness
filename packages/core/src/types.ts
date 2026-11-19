import { z } from 'zod';

export const TaskStatusSchema = z.enum([
  'queued',
  'running',
  'verifying',
  'awaiting_approval',
  'pushing',
  'done',
  'needs_info',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RepoSchema = z.object({
  id: z.string(),
  name: z.string(),
  localPath: z.string(),
  githubOwner: z.string().nullable().optional(),
  githubRepo: z.string().nullable().optional(),
  defaultBranch: z.string().default('main'),
  testCommand: z.string().nullable().optional(),
  lintCommand: z.string().nullable().optional(),
  typecheckCommand: z.string().nullable().optional(),
  installCommand: z.string().nullable().optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  type: z.string().default('bugfix'),
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema.default('queued'),
  branchName: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  containerId: z.string().nullable().optional(),
  attempt: z.number().int().default(1),
  maxSteps: z.number().int().default(40),
  maxCostUsd: z.coerce.number().default(2.0),
  maxMinutes: z.number().int().default(30),
  failureReason: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const StepKindSchema = z.enum(['llm_call', 'tool_call', 'verify']);
export type StepKind = z.infer<typeof StepKindSchema>;

export const DecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type Decision = z.infer<typeof DecisionSchema>;

export const StepSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  idx: z.number().int(),
  kind: StepKindSchema,
  toolName: z.string().nullable().optional(),
  input: z.unknown().nullable().optional(),
  output: z.unknown().nullable().optional(),
  decision: DecisionSchema.nullable().optional(),
  promptTokens: z.number().int().default(0),
  completionTokens: z.number().int().default(0),
  costUsd: z.coerce.number().default(0),
  createdAt: z.coerce.date().optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const ApprovalKindSchema = z.enum(['tool_call', 'final_diff', 'push']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  stepId: z.string().nullable().optional(),
  kind: ApprovalKindSchema,
  summary: z.string(),
  payload: z.unknown().nullable().optional(),
  status: ApprovalStatusSchema.default('pending'),
  decidedAt: z.coerce.date().nullable().optional(),
  note: z.string().nullable().optional(),
  createdAt: z.coerce.date().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const VerificationSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  check: z.string(),
  passed: z.boolean(),
  output: z.string().nullable().optional(),
  createdAt: z.coerce.date().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const AuditActorSchema = z.enum(['agent', 'human', 'system']);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditLogSchema = z.object({
  id: z.coerce.number().optional(),
  taskId: z.string().nullable().optional(),
  actor: AuditActorSchema,
  action: z.string(),
  detail: z.unknown().nullable().optional(),
  createdAt: z.coerce.date().optional(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;
