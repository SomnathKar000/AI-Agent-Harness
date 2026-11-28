import { Command } from 'commander';
import type { HarnessClient } from './client.js';
import { detail, table, truncate } from './format.js';

export interface CommandDeps {
  client: HarnessClient;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * Last line of defence before anything reaches a terminal. `main()` wires this to the
   * client's own scrubber, so a token echoed back by a proxy, or embedded in an error
   * raised somewhere we do not control, still cannot be printed.
   */
  scrub?: (text: string) => string;
}

type Row = Record<string, unknown>;

/**
 * Every command is a thin wrapper over one API call. The CLI holds no business logic
 * and no database handle (hard rule 1).
 */
export function buildProgram(deps: CommandDeps): Command {
  const { client } = deps;
  const scrub = deps.scrub ?? ((t: string) => t);
  const out = (line: string): void => deps.out(scrub(line));
  const err = (line: string): void => deps.err(scrub(line));

  const program = new Command();
  program
    .name('harness')
    .description('Submit tasks to the agent harness and review what it wants to do.')
    .exitOverride();
  program.configureOutput({
    writeOut: (s) => out(s.replace(/\n$/, '')),
    writeErr: (s) => err(s.replace(/\n$/, '')),
  });

  /** Reports a failure without ever echoing the token the client holds. */
  const guard =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await fn(...args);
      } catch (e) {
        err(e instanceof Error ? e.message : String(e));
        throw e;
      }
    };

  // --- repo ---------------------------------------------------------------
  const repo = program.command('repo').description('Repositories the harness may work in');

  repo
    .command('list')
    .description('List registered repositories')
    .action(
      guard(async () => {
        const { repos } = await client.listRepos();
        out(table(repos as Row[], ['id', 'name', 'localPath', 'defaultBranch']));
      })
    );

  repo
    .command('add')
    .description('Register a repository')
    .requiredOption('--name <name>', 'short name')
    .requiredOption('--path <path>', 'absolute path to the local clone')
    .option('--branch <branch>', 'default branch', 'main')
    .option('--test-command <cmd>', 'command that runs the tests')
    .option('--lint-command <cmd>', 'command that lints')
    .option('--typecheck-command <cmd>', 'command that typechecks')
    .option('--install-command <cmd>', 'command that installs dependencies')
    .action(
      guard(async (opts: Record<string, string | undefined>) => {
        const { repo: created } = await client.createRepo({
          name: opts.name,
          localPath: opts.path,
          defaultBranch: opts.branch,
          testCommand: opts.testCommand,
          lintCommand: opts.lintCommand,
          typecheckCommand: opts.typecheckCommand,
          installCommand: opts.installCommand,
        });
        out(`registered repo ${created.id}`);
      })
    );

  // --- task ---------------------------------------------------------------
  const task = program.command('task').description('Tasks the agent runs');

  task
    .command('list')
    .description('List tasks')
    .option('--status <status>', 'filter by status')
    .option('--limit <n>', 'maximum rows', (v) => Number(v))
    .action(
      guard(async (opts: { status?: string; limit?: number }) => {
        const { tasks } = await client.listTasks({ status: opts.status, limit: opts.limit });
        const rows = (tasks as Row[]).map((t) => ({
          ...t,
          description: truncate(String(t.description ?? ''), 60),
        }));
        out(table(rows, ['id', 'status', 'attempt', 'description']));
      })
    );

  task
    .command('create')
    .description('Queue a new task')
    .requiredOption('--repo <id>', 'repository id')
    .requiredOption('--description <text>', 'what to fix')
    .option('--max-steps <n>', 'step budget', (v) => Number(v))
    .action(
      guard(async (opts: { repo: string; description: string; maxSteps?: number }) => {
        const { task: created } = await client.createTask({
          repoId: opts.repo,
          description: opts.description,
          ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
        });
        out(`queued task ${created.id}`);
      })
    );

  task
    .command('show <id>')
    .description('Show one task with its steps, verifications and cost')
    .action(
      guard(async (id: string) => {
        const d = (await client.getTask(id)) as {
          task?: Row;
          steps?: Row[];
          verifications?: Row[];
          approvals?: Row[];
          cost?: Row;
        };
        if (d.task) out(detail(d.task));
        if (d.cost) out(`\ncost: ${JSON.stringify(d.cost)}`);
        if (d.verifications?.length) {
          out('\nverifications:');
          out(table(d.verifications, ['name', 'passed', 'rule']));
        }
        if (d.approvals?.length) {
          out('\napprovals:');
          out(table(d.approvals, ['id', 'kind', 'status', 'summary']));
        }
        if (d.steps?.length) out(`\nsteps: ${d.steps.length}`);
      })
    );

  task
    .command('cancel <id>')
    .description('Cancel a running task')
    .action(
      guard(async (id: string) => {
        await client.cancelTask(id);
        out(`cancelled ${id}`);
      })
    );

  task
    .command('retry <id>')
    .description('Re-queue a failed task')
    .action(
      guard(async (id: string) => {
        await client.retryTask(id);
        out(`re-queued ${id}`);
      })
    );

  // --- logs ---------------------------------------------------------------
  program
    .command('logs <id>')
    .description('Follow a task log stream until it reaches a terminal state')
    .action(
      guard(async (id: string) => {
        for await (const line of client.streamLogs(id)) out(line);
      })
    );

  // --- approvals ----------------------------------------------------------
  const approvals = program.command('approvals').description('Pending human decisions');

  approvals
    .command('list')
    .description('List approvals (pending by default)')
    .option('--status <status>', 'filter by status', 'pending')
    .option('--task <id>', 'filter by task')
    .action(
      guard(async (opts: { status?: string; task?: string }) => {
        const { approvals: rows } = await client.listApprovals({
          status: opts.status,
          taskId: opts.task,
        });
        const shaped = (rows as Row[]).map((a) => ({
          ...a,
          summary: truncate(String(a.summary ?? ''), 60),
        }));
        out(table(shaped, ['id', 'taskId', 'kind', 'status', 'summary']));
      })
    );

  program
    .command('approve <approvalId>')
    .description('Approve a pending request')
    .option('--note <text>', 'note stored with the decision')
    .action(
      guard(async (id: string, opts: { note?: string }) => {
        await client.decideApproval(id, true, opts.note);
        out(`approved ${id}`);
      })
    );

  program
    .command('reject <approvalId>')
    .description('Reject a pending request')
    .option('--note <text>', 'note stored with the decision')
    .action(
      guard(async (id: string, opts: { note?: string }) => {
        await client.decideApproval(id, false, opts.note);
        out(`rejected ${id}`);
      })
    );

  return program;
}
