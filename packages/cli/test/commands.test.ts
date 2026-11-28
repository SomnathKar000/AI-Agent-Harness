import { describe, it, expect, beforeEach } from 'vitest';
import { buildProgram } from '../src/commands.js';
import type { HarnessClient } from '../src/client.js';

const TOKEN = 'tok-SUPERSECRET-0123456789';

interface Call { name: string; args: unknown[] }

function stubClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const record = (name: string, result: unknown) => (...args: unknown[]) => {
    calls.push({ name, args });
    return Promise.resolve(result);
  };
  const client = {
    listRepos: record('listRepos', { repos: [{ id: 'r1', name: 'demo', localPath: '/tmp/demo' }] }),
    createRepo: record('createRepo', { repo: { id: 'r1', name: 'demo' } }),
    listTasks: record('listTasks', { tasks: [{ id: 't1', status: 'queued', description: 'fix' }] }),
    createTask: record('createTask', { task: { id: 't1', status: 'queued' } }),
    getTask: record('getTask', { task: { id: 't1', status: 'running' }, steps: [], verifications: [], approvals: [], cost: { costUsd: 0 } }),
    cancelTask: record('cancelTask', { task: { id: 't1', status: 'cancelled' } }),
    retryTask: record('retryTask', { task: { id: 't1', status: 'queued', attempt: 2 } }),
    listApprovals: record('listApprovals', { approvals: [{ id: 'a1', kind: 'tool_call', summary: 'run_command', status: 'pending' }] }),
    decideApproval: record('decideApproval', { approval: { id: 'a1', status: 'approved' } }),
    ...overrides,
  } as unknown as HarnessClient;
  return { client, calls };
}

let out: string[];
let err: string[];

function program(client: HarnessClient) {
  out = [];
  err = [];
  // `main()` wires this to the real client's scrubber; here it stands in for it, so the
  // assertion below exercises the command layer rather than the client's own masking.
  const scrub = (t: string) => t.split(TOKEN).join('[REDACTED]');
  return buildProgram({ client, out: (s) => out.push(s), err: (s) => err.push(s), scrub });
}

async function run(client: HarnessClient, argv: string[]) {
  await program(client).parseAsync(['node', 'harness', ...argv]);
}

describe('CLI commands', () => {
  let stub: ReturnType<typeof stubClient>;
  beforeEach(() => {
    stub = stubClient();
  });

  it('repo list calls the API and prints the repos', async () => {
    await run(stub.client, ['repo', 'list']);
    expect(stub.calls.map((c) => c.name)).toEqual(['listRepos']);
    expect(out.join('\n')).toContain('demo');
  });

  it('repo add posts the repo', async () => {
    await run(stub.client, ['repo', 'add', '--name', 'demo', '--path', '/tmp/demo']);
    expect(stub.calls[0].name).toBe('createRepo');
    expect(stub.calls[0].args[0]).toMatchObject({ name: 'demo', localPath: '/tmp/demo' });
  });

  it('task create posts repoId and description', async () => {
    await run(stub.client, ['task', 'create', '--repo', 'r1', '--description', 'fix the pagination bug']);
    expect(stub.calls[0].name).toBe('createTask');
    expect(stub.calls[0].args[0]).toMatchObject({ repoId: 'r1', description: 'fix the pagination bug' });
  });

  it('task list passes a status filter through', async () => {
    await run(stub.client, ['task', 'list', '--status', 'running']);
    expect(stub.calls[0].name).toBe('listTasks');
    expect(stub.calls[0].args[0]).toMatchObject({ status: 'running' });
  });

  it('task show fetches one task', async () => {
    await run(stub.client, ['task', 'show', 't1']);
    expect(stub.calls[0]).toMatchObject({ name: 'getTask', args: ['t1'] });
  });

  it('task cancel and task retry hit their endpoints', async () => {
    await run(stub.client, ['task', 'cancel', 't1']);
    expect(stub.calls[0]).toMatchObject({ name: 'cancelTask', args: ['t1'] });
    stub = stubClient();
    await run(stub.client, ['task', 'retry', 't1']);
    expect(stub.calls[0]).toMatchObject({ name: 'retryTask', args: ['t1'] });
  });

  it('approvals list defaults to pending', async () => {
    await run(stub.client, ['approvals', 'list']);
    expect(stub.calls[0].name).toBe('listApprovals');
    expect(stub.calls[0].args[0]).toMatchObject({ status: 'pending' });
  });

  it('approve sends approved=true', async () => {
    await run(stub.client, ['approve', 'a1']);
    expect(stub.calls[0]).toMatchObject({ name: 'decideApproval', args: ['a1', true, undefined] });
  });

  it('reject sends approved=false with the note', async () => {
    await run(stub.client, ['reject', 'a1', '--note', 'too risky']);
    expect(stub.calls[0]).toMatchObject({ name: 'decideApproval', args: ['a1', false, 'too risky'] });
  });

  it('a failing call reports the error without leaking the token', async () => {
    const failing = stubClient({
      listRepos: () => Promise.reject(new Error(`boom ${TOKEN}`)),
    });
    await expect(run(failing.client, ['repo', 'list'])).rejects.toThrow();
    expect(err.join('\n')).not.toContain('SUPERSECRET');
  });

  it('prints no secret-looking value in any successful output', async () => {
    await run(stub.client, ['task', 'show', 't1']);
    expect(out.join('\n')).not.toContain('SUPERSECRET');
    expect(out.join('\n')).not.toMatch(/Bearer /);
  });
});
