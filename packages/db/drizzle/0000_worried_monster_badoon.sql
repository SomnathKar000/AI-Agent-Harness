CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"step_id" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"local_path" text NOT NULL,
	"github_owner" text,
	"github_repo" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"test_command" text,
	"lint_command" text,
	"typecheck_command" text,
	"install_command" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"idx" integer NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"input" jsonb,
	"output" jsonb,
	"decision" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0.0000' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"type" text DEFAULT 'bugfix' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"branch_name" text,
	"worktree_path" text,
	"container_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_steps" integer DEFAULT 40 NOT NULL,
	"max_cost_usd" numeric(10, 2) DEFAULT '2.00' NOT NULL,
	"max_minutes" integer DEFAULT 30 NOT NULL,
	"failure_reason" text,
	"pr_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"check" text NOT NULL,
	"passed" boolean NOT NULL,
	"output" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;