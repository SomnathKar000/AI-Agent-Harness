import type {
  PolicyGate,
  ToolCall,
  PolicyDecision,
  LLMClient,
  CompleteOptions,
  CompletionResponse,
  ToolExecutor,
  StepLogger,
  LogStepParams,
} from './types.js';

export class AllowAllGate implements PolicyGate {
  evaluate(): PolicyDecision {
    return { action: 'allow' };
  }
}

export class DenyAllGate implements PolicyGate {
  constructor(private reason: string = 'operation denied by policy') {}

  evaluate(): PolicyDecision {
    return { action: 'deny', reason: this.reason };
  }
}

export class AskAllGate implements PolicyGate {
  evaluate(): PolicyDecision {
    return { action: 'ask', reason: 'requires human confirmation' };
  }
}

export class CustomPolicyGate implements PolicyGate {
  constructor(
    private handler: (call: ToolCall) => Promise<PolicyDecision> | PolicyDecision
  ) {}

  evaluate(call: ToolCall): Promise<PolicyDecision> | PolicyDecision {
    return this.handler(call);
  }
}

export class FakeLLMClient implements LLMClient {
  public calls: CompleteOptions[] = [];
  private responses: (CompletionResponse | ((options: CompleteOptions) => CompletionResponse))[];
  private currentIndex = 0;

  constructor(
    responses: (CompletionResponse | ((options: CompleteOptions) => CompletionResponse))[]
  ) {
    this.responses = responses;
  }

  async complete(options: CompleteOptions): Promise<CompletionResponse> {
    this.calls.push({
      ...options,
      messages: JSON.parse(JSON.stringify(options.messages)),
    });
    if (this.currentIndex >= this.responses.length) {
      throw new Error(`FakeLLMClient: No more mocked responses (called ${this.calls.length} times)`);
    }
    const item = this.responses[this.currentIndex++];
    if (typeof item === 'function') {
      return item(options);
    }
    return item;
  }
}

export class InMemoryToolExecutor implements ToolExecutor {
  public files = new Map<string, string>();
  public commandHistory: { argv: string[]; timeoutMs?: number }[] = [];
  public commandMocks = new Map<string, { exitCode: number; stdout: string; stderr: string; timedOut: boolean }>();

  async listDir(targetPath: string = '.'): Promise<string[]> {
    const prefix = targetPath === '.' || targetPath === '' ? '' : targetPath.replace(/\/$/, '') + '/';
    const entries = new Set<string>();
    for (const key of this.files.keys()) {
      if (prefix === '' || key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const topLevel = rest.split('/')[0];
        if (topLevel) entries.add(topLevel);
      }
    }
    return Array.from(entries);
  }

  async readFile(filePath: string, offset?: number, limit?: number): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }
    if (Buffer.byteLength(content, 'utf8') > 200 * 1024 && offset === undefined && limit === undefined) {
      throw new Error(`File is too large (> 200KB). Use offset and limit to read lines.`);
    }
    if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const count = limit ?? lines.length - start;
      const slice = lines.slice(start, start + count).join('\n');
      if (Buffer.byteLength(slice, 'utf8') > 200 * 1024) {
        throw new Error('Requested line slice exceeds 200KB limit.');
      }
      return slice;
    }
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async editFile(filePath: string, oldString: string, newString: string): Promise<void> {
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }
    let count = 0;
    let pos = content.indexOf(oldString);
    while (pos !== -1) {
      count++;
      pos = content.indexOf(oldString, pos + oldString.length);
    }
    if (count === 0) {
      throw new Error(`Error: old_string not found in ${filePath}`);
    }
    if (count > 1) {
      throw new Error(`Error: old_string matches ${count} times in ${filePath}. Must match exactly once.`);
    }
    const updated = content.replace(oldString, newString);
    this.files.set(filePath, updated);
  }

  async grep(pattern: string, targetPath: string = '.'): Promise<string> {
    const matches: string[] = [];
    const prefix = targetPath === '.' || targetPath === '' ? '' : targetPath.replace(/\/$/, '') + '/';
    for (const [key, content] of this.files.entries()) {
      if (prefix === '' || key.startsWith(prefix)) {
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (line.includes(pattern)) {
            matches.push(`${key}:${idx + 1}:${line}`);
          }
        });
      }
    }
    return matches.length > 0 ? matches.join('\n') : 'No matches found.';
  }

  async runCommand(
    argv: string[],
    timeoutMs?: number
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    this.commandHistory.push({ argv, timeoutMs });
    const key = argv.join(' ');
    const mock = this.commandMocks.get(key);
    if (mock) {
      return mock;
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  }
}

export class InMemoryStepLogger implements StepLogger {
  public steps: LogStepParams[] = [];

  async logStep(params: LogStepParams): Promise<void> {
    this.steps.push(params);
  }
}
