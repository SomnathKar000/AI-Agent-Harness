import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMClient,
  CompleteOptions,
  CompletionResponse,
  AssistantContentBlock,
  StopReason,
} from './types.js';
import { getAgentModel } from './config.js';

export interface ClaudeClientOptions {
  apiKey?: string;
  model?: string;
  retryDelayMs?: number;
  clientOverride?: Anthropic;
}

export class ClaudeClient implements LLMClient {
  private client: Anthropic;
  private model: string;
  private retryDelayMs: number;

  constructor(options?: ClaudeClientOptions) {
    const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey && !options?.clientOverride) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. It must be provided in the host environment.'
      );
    }

    this.model = options?.model ?? getAgentModel();
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
    this.client =
      options?.clientOverride ??
      new Anthropic({
        apiKey,
        maxRetries: 0, // We control retries explicitly
      });
  }

  async complete(options: CompleteOptions): Promise<CompletionResponse> {
    const tools: Anthropic.Tool[] | undefined =
      options.tools && options.tools.length > 0
        ? options.tools.map((tool, index) => {
            const toolDef: Anthropic.Tool = {
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
            };
            // Put cache_control on the last tool definition
            if (index === options.tools!.length - 1) {
              (
                toolDef as Anthropic.Tool & {
                  cache_control?: { type: 'ephemeral' };
                }
              ).cache_control = { type: 'ephemeral' };
            }
            return toolDef;
          })
        : undefined;

    const formattedMessages: Anthropic.MessageParam[] = options.messages.map((m) => {
      if (typeof m.content === 'string') {
        return {
          role: m.role,
          content: m.content,
        };
      }
      return {
        role: m.role,
        content: m.content.map((block) => {
          if (block.type === 'tool_result') {
            const resultBlock: Anthropic.ToolResultBlockParam = {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error,
            };
            return resultBlock;
          }
          if (block.type === 'tool_use') {
            const useBlock: Anthropic.ToolUseBlockParam = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            };
            return useBlock;
          }
          const textBlock: Anthropic.TextBlockParam = {
            type: 'text',
            text: block.text,
          };
          return textBlock;
        }),
      };
    });

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: options.maxTokens ?? 4096,
          system: [
            {
              type: 'text',
              text: options.system,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: formattedMessages,
          tools,
        });

        const contentBlocks: AssistantContentBlock[] = response.content.map((block) => {
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            };
          }
          if (block.type === 'text') {
            return {
              type: 'text',
              text: block.text,
            };
          }
          return {
            type: 'text',
            text: '',
          };
        });

        const stopReason: StopReason = response.stop_reason;

        const usageObj = response.usage as {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number | null;
          cache_read_input_tokens?: number | null;
        };

        const usage = {
          inputTokens: usageObj.input_tokens,
          outputTokens: usageObj.output_tokens,
          cacheCreationInputTokens: usageObj.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: usageObj.cache_read_input_tokens ?? 0,
        };

        return {
          content: contentBlocks,
          stopReason,
          usage,
        };
      } catch (err: unknown) {
        if (!this.isRetryable(err) || attempt >= maxAttempts) {
          throw err;
        }

        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('ClaudeClient: Max retry attempts reached without response');
  }

  private isRetryable(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const errorRecord = err as Record<string, unknown>;
    const status = typeof errorRecord.status === 'number' ? errorRecord.status : undefined;
    const name = typeof errorRecord.name === 'string' ? errorRecord.name : undefined;
    const code = typeof errorRecord.code === 'string' ? errorRecord.code : undefined;
    const message = typeof errorRecord.message === 'string' ? errorRecord.message : undefined;

    // Retry 429
    if (status === 429) {
      return true;
    }

    // Retry 5xx server errors
    if (status !== undefined && status >= 500 && status < 600) {
      return true;
    }

    // Never retry other 4xx client errors (400, 401, 403, 404, etc.)
    if (status !== undefined && status >= 400 && status < 500) {
      return false;
    }

    // Retry network errors
    if (
      name === 'APIConnectionError' ||
      name === 'APIConnectionTimeoutError' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      (err instanceof TypeError && message?.toLowerCase().includes('fetch'))
    ) {
      return true;
    }

    return false;
  }
}
