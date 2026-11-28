export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type UserContentBlock = TextBlock | ToolResultBlock;

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | (AssistantContentBlock | UserContentBlock)[];
}

export interface ToolParam {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  cache_control?: { type: 'ephemeral' };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type StopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | string | null;

export interface CompletionResponse {
  content: AssistantContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

export interface CompleteOptions {
  system: string;
  messages: LLMMessage[];
  tools?: ToolParam[];
  maxTokens?: number;
}

export interface LLMClient {
  complete(options: CompleteOptions): Promise<CompletionResponse>;
}

export interface ToolExecutor {
  listDir(path?: string): Promise<string[] | string>;
  readFile(path: string, offset?: number, limit?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void | string>;
  editFile(path: string, oldString: string, newString: string): Promise<void | string>;
  grep(pattern: string, path?: string): Promise<string>;
  runCommand(
    argv: string[],
    timeoutMs?: number
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
}

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason?: string };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface PolicyGate {
  evaluate(call: ToolCall): Promise<PolicyDecision> | PolicyDecision;
  redact?(call: ToolCall, resultText: string): string;
  maskSecrets?(text: string): string;
}

export interface LogStepParams {
  taskId: string;
  idx: number;
  kind: 'llm_call' | 'tool_call' | 'verify';
  toolName?: string | null;
  input?: unknown;
  output?: unknown;
  decision?: 'allow' | 'ask' | 'deny' | null;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}

export interface StepLogger {
  logStep(params: LogStepParams): Promise<void>;
}

export interface ModelPricing {
  input: number;
  output: number;
  cache_write?: number;
  cache_read?: number;
  inputTokensPerMillion?: number;
  outputTokensPerMillion?: number;
  cacheWriteTokensPerMillion?: number;
  cacheReadTokensPerMillion?: number;
}

export interface AgentTask {
  id: string;
  description: string;
  maxSteps?: number;
  maxCostUsd?: number;
  maxMinutes?: number;
}

export type AgentResult =
  | { status: 'done'; summary: string; rootCause: string }
  | { status: 'needs_info'; question: string }
  | { status: 'failed'; reason: string };

/**
 * A mid-run tool approval. The gate returned `ask`; a human has to decide before the
 * tool may run. Phase 7.
 */
export interface ApprovalRequest {
  taskId: string;
  toolCall: ToolCall;
  /** The policy's reason for asking, already masked by the gate. */
  reason?: string;
}

/**
 * The result of waiting for a human. There is no third state on purpose: a timeout, a
 * lost connection or an unreadable row is a `rejected`, never a silent allow
 * (hard rule 13).
 */
export type ApprovalOutcome =
  | { status: 'approved'; note?: string }
  | { status: 'rejected'; reason: string };

/**
 * Injected by the worker. The agent package never reads the database itself, so this
 * stays a port (hard rule 1).
 *
 * Implementations must fail closed. The loop additionally treats a throw as a rejection,
 * with one exception: an error whose `name` is `CancelledError` is rethrown, so a task
 * cancelled while paused aborts the run instead of resuming with a denial. The name is
 * matched as a string rather than by importing the class, to keep the dependency
 * direction intact.
 */
export interface ApprovalWaiter {
  waitForApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

export interface AgentDeps {
  llm: LLMClient;
  gate: PolicyGate;
  executor: ToolExecutor;
  logger: StepLogger;
  pricingTable?: Record<string, ModelPricing>;
  model?: string;
  maxHistoryTokens?: number;
  systemPrompt?: string;
  /**
   * Optional. When absent the loop keeps the pre-Phase-7 behaviour and denies every
   * `ask` with "approval not implemented".
   */
  approvalWaiter?: ApprovalWaiter;
}
