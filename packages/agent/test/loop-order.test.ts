import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/loop.js';
import type {
  LLMClient,
  PolicyGate,
  ToolExecutor,
  StepLogger,
  LogStepParams,
  CompleteOptions,
  CompletionResponse,
} from '../src/types.js';

describe('Item 5: loop.ts tool execution order (redact/mask -> truncate -> log -> return to model)', () => {
  it('masks secret starting 3 characters before 20KB truncation boundary before truncating', async () => {
    const CANARY = 'canary-7f3a9';
    const boundary = 20 * 1024; // 20480 bytes

    // Header added by run_command is "Exit code: 0\nSTDOUT:\n" (21 bytes)
    const header = 'Exit code: 0\nSTDOUT:\n';
    const headerLen = Buffer.byteLength(header, 'utf8');

    // Build raw output where CANARY starts exactly 3 bytes before 20KB boundary in combined output
    const prefix = 'A'.repeat(boundary - headerLen - 3);
    const suffix = 'B'.repeat(100);
    const rawToolOutput = prefix + CANARY + suffix;

    let receivedByModel: string | undefined;
    const recordedSteps: LogStepParams[] = [];

    const mockLlm: LLMClient = {
      turn: 0,
      async complete(options: CompleteOptions): Promise<CompletionResponse> {
        const lastMsg = options.messages[options.messages.length - 1];
        if (lastMsg && Array.isArray(lastMsg.content)) {
          for (const block of lastMsg.content) {
            if (block.type === 'tool_result') {
              receivedByModel = block.content;
            }
          }
        }

        (this as any).turn++;
        if ((this as any).turn === 1) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_cmd',
                name: 'run_command',
                input: { argv: ['node', 'script.js'] },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }

        return {
          content: [
            {
              type: 'tool_use',
              id: 'call_finish',
              name: 'finish',
              input: { summary: 'Done', root_cause: 'Testing' },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    } as any;

    const mockGate: PolicyGate = {
      async evaluate() {
        return { action: 'allow' };
      },
      redact(_call, text) {
        return text.split(CANARY).join('[REDACTED]');
      },
    };

    const mockExecutor: ToolExecutor = {
      async listDir() { return []; },
      async readFile() { return ''; },
      async writeFile() {},
      async editFile() {},
      async grep() { return ''; },
      async runCommand() {
        return {
          exitCode: 0,
          stdout: rawToolOutput,
          stderr: '',
          timedOut: false,
        };
      },
    };

    const mockLogger: StepLogger = {
      async logStep(params) {
        recordedSteps.push(params);
      },
    };

    const result = await runAgent(
      {
        id: 'test-order-task',
        description: 'Test order of redact and truncate',
        maxSteps: 5,
        maxCostUsd: 1.0,
        maxMinutes: 1,
      },
      {
        llm: mockLlm,
        gate: mockGate,
        executor: mockExecutor,
        logger: mockLogger,
      }
    );

    expect(result.status).toBe('done');

    expect(receivedByModel).toBeDefined();
    // Neither the model result nor the DB contains any part of the canary except inside [REDACTED]
    expect(receivedByModel).not.toContain(CANARY);
    expect(receivedByModel).not.toContain('canary');
    expect(receivedByModel).not.toContain('can');

    const loggedOutput = recordedSteps.find((s) => s.kind === 'tool_call')?.output;
    expect(loggedOutput).toBeDefined();
    expect(loggedOutput).not.toContain(CANARY);
    expect(loggedOutput).not.toContain('canary');
    expect(loggedOutput).not.toContain('can');
  });
});
