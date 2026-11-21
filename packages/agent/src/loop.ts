import type {
  AgentTask,
  AgentDeps,
  AgentResult,
  LLMMessage,
  ToolUseBlock,
  ToolResultBlock,
  LogStepParams,
} from './types.js';
import { BUGFIX_SYSTEM_PROMPT } from './prompts/bugfix.js';
import { AGENT_TOOLS, executeTool, truncateToolOutput } from './tools/index.js';
import { calculateCost, getAgentModel } from './config.js';

export function estimateMessageTokens(messages: LLMMessage[]): number {
  let charCount = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      charCount += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') {
          charCount += block.text.length;
        }
        if ('input' in block && block.input) {
          charCount += JSON.stringify(block.input).length;
        }
        if ('content' in block && typeof block.content === 'string') {
          charCount += block.content.length;
        }
      }
    }
  }
  return Math.ceil(charCount / 4);
}

export function elideOldestToolResults(
  messages: LLMMessage[],
  maxTokens: number
): void {
  while (estimateMessageTokens(messages) > maxTokens) {
    let elidedAny = false;
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && block.content !== '[output elided]') {
            block.content = '[output elided]';
            elidedAny = true;
            break;
          }
        }
      }
      if (elidedAny) break;
    }
    if (!elidedAny) {
      break;
    }
  }
}

function maskAndTruncateValue(
  value: unknown,
  maskFn?: (str: string) => string,
  maxStringLength = 2048
): unknown {
  if (typeof value === 'string') {
    let s = maskFn ? maskFn(value) : value;
    if (s.length > maxStringLength) {
      const truncatedBytes = Buffer.byteLength(s.slice(maxStringLength));
      s = s.slice(0, maxStringLength) + ` [truncated ${truncatedBytes} bytes]`;
    }
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskAndTruncateValue(item, maskFn, maxStringLength));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskAndTruncateValue(v, maskFn, maxStringLength);
    }
    return out;
  }
  return value;
}

export async function runAgent(
  task: AgentTask,
  deps: AgentDeps
): Promise<AgentResult> {
  if (!deps.gate) {
    throw new Error('PolicyGate is required in deps for runAgent');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = deps.model ?? getAgentModel();
  const maxSteps = task.maxSteps ?? 40;
  const maxCostUsd = task.maxCostUsd ?? 2.0;
  const maxMinutes = task.maxMinutes ?? 30;
  const maxHistoryTokens = deps.maxHistoryTokens ?? 100_000;
  const systemPrompt = deps.systemPrompt ?? BUGFIX_SYSTEM_PROMPT;

  const startTimeMs = Date.now();
  let stepCount = 0;
  let accumulatedCostUsd = 0;
  let stepIdx = 1;

  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: task.description,
    },
  ];

  const maskText = (text: string): string => {
    let masked = text;
    if (deps.gate?.maskSecrets) {
      masked = deps.gate.maskSecrets(masked);
    }
    if (apiKey && apiKey.length >= 5) {
      masked = masked.replaceAll(apiKey, '[REDACTED_API_KEY]');
    }
    return masked;
  };

  const logStep = async (params: LogStepParams): Promise<void> => {
    const sanitized = maskAndTruncateValue(params, maskText) as LogStepParams;
    await deps.logger.logStep(sanitized);
  };

  while (true) {
    // 1. Check limits BEFORE each LLM call
    if (stepCount >= maxSteps) {
      return {
        status: 'failed',
        reason: `Step limit reached (${maxSteps})`,
      };
    }

    if (accumulatedCostUsd >= maxCostUsd) {
      return {
        status: 'failed',
        reason: `Cost limit reached ($${accumulatedCostUsd.toFixed(4)} >= $${maxCostUsd})`,
      };
    }

    const elapsedMinutes = (Date.now() - startTimeMs) / 60000;
    if (elapsedMinutes >= maxMinutes) {
      return {
        status: 'failed',
        reason: `Time limit reached (${maxMinutes}m)`,
      };
    }

    // 2. Context control
    elideOldestToolResults(messages, maxHistoryTokens);

    // 3. Complete with LLM
    const response = await deps.llm.complete({
      system: systemPrompt,
      messages,
      tools: AGENT_TOOLS,
    });

    stepCount++;
    const callCost = calculateCost(model, response.usage, deps.pricingTable);
    accumulatedCostUsd += callCost;

    await logStep({
      taskId: task.id,
      idx: stepIdx++,
      kind: 'llm_call',
      input: messages,
      output: response.content,
      decision: null,
      promptTokens: response.usage.inputTokens,
      completionTokens: response.usage.outputTokens,
      costUsd: callCost,
    });

    // 4. Handle stop_reason: max_tokens (treat as error step, do not execute partial tool calls)
    if (response.stopReason === 'max_tokens') {
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use'
      );

      messages.push({
        role: 'assistant',
        content: response.content,
      });

      if (toolUseBlocks.length > 0) {
        const errorResults: ToolResultBlock[] = toolUseBlocks.map((b) => ({
          type: 'tool_result',
          tool_use_id: b.id,
          is_error: true,
          content:
            'Error: Response cut off because max_tokens was reached. Partial tool calls were not executed.',
        }));

        messages.push({
          role: 'user',
          content: errorResults,
        });
      } else {
        messages.push({
          role: 'user',
          content: 'Error: Generation hit max_tokens limit. Please provide a shorter response.',
        });
      }

      continue;
    }

    // Add assistant response to messages
    messages.push({
      role: 'assistant',
      content: response.content,
    });

    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0) {
      // Model returned text without tool use
      if (response.stopReason === 'end_turn') {
        messages.push({
          role: 'user',
          content:
            'Please continue fixing the bug using the tools, or call finish if you have completed the task.',
        });
      }
      continue;
    }

    // 5. Tool calls run SEQUENTIALLY, one at a time
    const toolResults: ToolResultBlock[] = [];
    let finishData: { summary: string; root_cause: string } | undefined;
    let needsInfoData: { question: string } | undefined;

    for (const toolUse of toolUseBlocks) {
      const toolCall = {
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      };

      const decision = await deps.gate.evaluate(toolCall);

      if (decision.action === 'deny') {
        const reason = decision.reason || 'operation denied';
        const content = `denied: ${reason}`;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content,
        });

        await logStep({
          taskId: task.id,
          idx: stepIdx++,
          kind: 'tool_call',
          toolName: toolUse.name,
          input: toolUse.input,
          output: content,
          decision: 'deny',
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
        });
        continue;
      }

      if (decision.action === 'ask') {
        // Treat ask as deny with reason "approval not implemented"
        const content = 'denied: approval not implemented';
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content,
        });

        await logStep({
          taskId: task.id,
          idx: stepIdx++,
          kind: 'tool_call',
          toolName: toolUse.name,
          input: toolUse.input,
          output: content,
          decision: 'ask',
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
        });
        continue;
      }

      // Allowed - execute tool
      const execResult = await executeTool(toolUse.name, toolUse.input, deps.executor);

      let finalContent = execResult.content;
      if (deps.gate.redact) {
        finalContent = deps.gate.redact(toolCall, finalContent);
      }

      finalContent = truncateToolOutput(finalContent);

      await logStep({
        taskId: task.id,
        idx: stepIdx++,
        kind: 'tool_call',
        toolName: toolUse.name,
        input: toolUse.input,
        output: finalContent,
        decision: 'allow',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        is_error: execResult.isError,
        content: finalContent,
      });

      if (execResult.finishData) {
        finishData = execResult.finishData;
      }
      if (execResult.needsInfoData) {
        needsInfoData = execResult.needsInfoData;
      }
    }

    // Every tool_use block MUST get exactly one matching tool_result in the next user message
    messages.push({
      role: 'user',
      content: toolResults,
    });

    if (finishData) {
      return {
        status: 'done',
        summary: finishData.summary,
        rootCause: finishData.root_cause,
      };
    }

    if (needsInfoData) {
      return {
        status: 'needs_info',
        question: needsInfoData.question,
      };
    }
  }
}
