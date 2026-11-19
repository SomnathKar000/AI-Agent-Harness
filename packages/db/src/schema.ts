import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  bigserial,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const taskStatusEnum = pgEnum('task_status', [
  'queued',
  'running',
  'paused',
  'needs_info',
  'verifying',
  'awaiting_approval',
  'pushing',
  'done',
  'failed',
  'cancelled',
]);

export const repos = pgTable('repos', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  localPath: text('local_path').notNull(),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  defaultBranch: text('default_branch').default('main').notNull(),
  testCommand: text('test_command'),
  lintCommand: text('lint_command'),
  typecheckCommand: text('typecheck_command'),
  installCommand: text('install_command'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  repoId: text('repo_id')
    .notNull()
    .references(() => repos.id, { onDelete: 'cascade' }),
  type: text('type').default('bugfix').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: taskStatusEnum('status').default('queued').notNull(),
  branchName: text('branch_name'),
  worktreePath: text('worktree_path'),
  containerId: text('container_id'),
  attempt: integer('attempt').default(1).notNull(),
  maxSteps: integer('max_steps').default(40).notNull(),
  maxCostUsd: numeric('max_cost_usd', { precision: 10, scale: 2 })
    .default('2.00')
    .notNull(),
  maxMinutes: integer('max_minutes').default(30).notNull(),
  failureReason: text('failure_reason'),
  prUrl: text('pr_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const taskSteps = pgTable('task_steps', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  kind: text('kind').notNull(), // llm_call | tool_call | verify
  toolName: text('tool_name'),
  input: jsonb('input'),
  output: jsonb('output'),
  decision: text('decision'), // allow | ask | deny
  promptTokens: integer('prompt_tokens').default(0).notNull(),
  completionTokens: integer('completion_tokens').default(0).notNull(),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 })
    .default('0.0000')
    .notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  stepId: text('step_id'),
  kind: text('kind').notNull(), // tool_call | final_diff | push
  summary: text('summary').notNull(),
  payload: jsonb('payload'),
  status: text('status').default('pending').notNull(), // pending | approved | rejected
  decidedAt: timestamp('decided_at'),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  check: text('check').notNull(),
  passed: boolean('passed').notNull(),
  output: text('output'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  taskId: text('task_id'),
  actor: text('actor').notNull(), // agent | human | system
  action: text('action').notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
