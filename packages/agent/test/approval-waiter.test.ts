import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/loop.js';
import {
  CustomPolicyGate,
  FakeLLMClient,
  InMemoryToolExecutor,
  InMemoryStepLogger,
} from '../src/test-utils.js';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalWaiter,
  CompletionResponse,
  PolicyDecision,
  PolicyGate,
  ToolCall,
  ToolResultBlock,
} from '../src/types.js';

/**
 * Phase 7: a policy `ask` must suspend the run and wait for a human, instead of being
 * hard-denied with "approval not implemented".
 *
 * These are the fail-closed tests (hard rule 13): anything other than an explicit
 * `approved` from the waiter must deny the tool, and the tool must never run.
 */

class RecordingWaiter implements ApprovalWaiter {
  public requests: ApprovalRequest[] = [];
  constructor(private readonly outcome: ApprovalOutcome | (() => Promise<never>)) {}
  async waitForApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.requests.push(req);
    if (typeof this.outcome === 'function') return this.outcome();
    return this.outcome;
  }
}

/** Gate that asks for run_command and allows everything else. */
function askOnRunCommand(extra?: Partial<PolicyGate>): PolicyGate {
  const gate = new CustomPolicyGate((call: ToolCall): PolicyDecision => {
    if (call.name === 'run_command') {
      return { action: 'ask', reason: 'requires human confirmation' };
    }
    return { action: 'allow' };
  });
  return Object.assign(gate, extra);
}

function responses(): CompletionResponse[] {
  return [
    {
      content: [
        { type: 'tool_use', id: 'call_1', name: 'run_command', input: { argv: ['ls', '-la'] } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 10 },
    },
    {
      content: [
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'finish',
          input: { summary: 'done', root_cause: 'none' },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 30, outputTokens: 15 },
    },
  ];
}

function lastToolResults(llm: FakeLLMClient): ToolResultBlock[] {
  const msgs = llm.calls[1].messages;
  return msgs[msgs.length - 1].content as ToolResultBlock[];
}

describe('ask -> human approval (fail closed)', () => {
  it('an approved decision lets the tool run', async () => {
    const executor = new InMemoryToolExecutor();
    const logger = new InMemoryStepLogger();
    const waiter = new RecordingWaiter({ status: 'approved' });
    const llm = new FakeLLMClient(responses());

    await runAgent(
      { id: 'task-appr', description: 'approved path' },
      { llm, gate: askOnRunCommand(), executor, logger, approvalWaiter: waiter }
    );

    expect(waiter.requests.length).toBe(1);
    expect(waiter.requests[0].taskId).toBe('task-appr');
    expect(waiter.requests[0].toolCall.name).toBe('run_command');
    // The tool actually ran.
    expect(executor.commandHistory.map((c) => c.argv.join(' '))).toContain('ls -la');
    expect(lastToolResults(llm)[0].is_error).not.toBe(true);
  });

  it('a rejected decision denies the tool and the tool never runs', async () => {
    const executor = new InMemoryToolExecutor();
    const logger = new InMemoryStepLogger();
    const waiter = new RecordingWaiter({ status: 'rejected', reason: 'human said no' });
    const llm = new FakeLLMClient(responses());

    await runAgent(
      { id: 'task-rej', description: 'rejected path' },
      { llm, gate: askOnRunCommand(), executor, logger, approvalWaiter: waiter }
    );

    expect(executor.commandHistory.length).toBe(0);
    const res = lastToolResults(llm)[0];
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('denied');
    expect(res.content).toContain('human said no');
  });

  it('a waiter that throws fails closed: denied, tool never runs', async () => {
    const executor = new InMemoryToolExecutor();
    const logger = new InMemoryStepLogger();
    const waiter = new RecordingWaiter(async () => {
      throw new Error('redis exploded');
    });
    const llm = new FakeLLMClient(responses());

    await runAgent(
      { id: 'task-throw', description: 'waiter throws' },
      { llm, gate: askOnRunCommand(), executor, logger, approvalWaiter: waiter }
    );

    expect(executor.commandHistory.length).toBe(0);
    const res = lastToolResults(llm)[0];
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('denied');
  });

  it('an unrecognised waiter outcome fails closed', async () => {
    const executor = new InMemoryToolExecutor();
    const logger = new InMemoryStepLogger();
    // Deliberately not a valid ApprovalOutcome.
    const waiter = new RecordingWaiter({ status: 'maybe' } as unknown as ApprovalOutcome);
    const llm = new FakeLLMClient(responses());

    await runAgent(
      { id: 'task-bogus', description: 'bogus outcome' },
      { llm, gate: askOnRunCommand(), executor, logger, approvalWaiter: waiter }
    );

    expect(executor.commandHistory.length).toBe(0);
    expect(lastToolResults(llm)[0].is_error).toBe(true);
  });

  it('the rejection reason is passed through the gate mask before it reaches the model', async () => {
    const executor = new InMemoryToolExecutor();
    const logger = new InMemoryStepLogger();
    const gate = askOnRunCommand({
      maskSecrets: (text: string) => text.replace('SUPERSECRET', '[REDACTED]'),
    });
    const waiter = new RecordingWaiter({ status: 'rejected', reason: 'no: SUPERSECRET' });
    const llm = new FakeLLMClient(responses());

    await runAgent(
      { id: 'task-mask', description: 'masking' },
      { llm, gate, executor, logger, approvalWaiter: waiter }
    );

    const content = lastToolResults(llm)[0].content;
    expect(content).not.toContain('SUPERSECRET');
    expect(content).toContain('[REDACTED]');
  });

  it('the human decision is written to the step log with decision "ask"', async () => {
    const executor = new InMemoryToolExecutor();
    const logger = new InMemoryStepLogger();
    const waiter = new RecordingWaiter({ status: 'rejected', reason: 'nope' });
    const llm = new FakeLLMClient(responses());

    await runAgent(
      { id: 'task-log', description: 'audit trail' },
      { llm, gate: askOnRunCommand(), executor, logger, approvalWaiter: waiter }
    );

    const askSteps = logger.steps.filter((s) => s.decision === 'ask');
    expect(askSteps.length).toBe(1);
    expect(askSteps[0].toolName).toBe('run_command');
  });

  it('with no waiter injected, the existing deny behaviour is unchanged', async () => {
    const executor = new InMemoryToolExecutor();
    const logger = new InMemoryStepLogger();
    const llm = new FakeLLMClient(responses());

    await runAgent(
      { id: 'task-nowaiter', description: 'no waiter' },
      { llm, gate: askOnRunCommand(), executor, logger }
    );

    expect(executor.commandHistory.length).toBe(0);
    expect(lastToolResults(llm)[0].content).toContain('denied: approval not implemented');
  });
});
