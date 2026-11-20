import crypto from 'node:crypto';
import type { PolicyGate as AgentPolicyGate, PolicyDecision, ToolCall } from '@harness/agent';
import { createApproval, appendAudit, appendStep, type Database } from '@harness/db';
import { loadPolicy } from './loader.js';
import { evaluate, isPathProtected } from './evaluator.js';
import type { PolicyConfig, PolicyContext } from './types.js';

export interface PolicyGateOptions {
  policy?: PolicyConfig;
  policyPath?: string;
  ctx: PolicyContext;
  db?: Database;
  recordTaskStep?: boolean;
  secretValues?: string[];
}

export class PolicyGate implements AgentPolicyGate {
  private policy: PolicyConfig;
  private ctx: PolicyContext;
  private db?: Database;
  private recordTaskStep: boolean;
  private secretValues: string[];
  private stepIdx: number;

  constructor(options: PolicyGateOptions) {
    if (!options.ctx || !options.ctx.taskId) {
      throw new Error('PolicyGate requires ctx.taskId');
    }
    this.policy = options.policy ?? loadPolicy(options.policyPath);
    this.ctx = {
      ...options.ctx,
      callCount: options.ctx?.callCount ?? 0,
    };
    this.db = options.db;
    this.recordTaskStep = options.recordTaskStep ?? false;
    this.secretValues = (options.secretValues ?? []).filter(
      (s) => typeof s === 'string' && s.length >= 8
    );
    this.stepIdx = 1;
  }

  maskSecrets(text: string): string {
    if (!text || this.secretValues.length === 0) return text;
    let result = text;
    for (const secret of this.secretValues) {
      if (secret && secret.length >= 8) {
        result = result.replaceAll(secret, '[REDACTED]');
      }
    }
    return result;
  }

  private sanitizeValue(val: unknown): unknown {
    if (typeof val === 'string') {
      let masked = this.maskSecrets(val);
      if (masked.length > 2048) {
        const truncatedBytes = Buffer.byteLength(masked.slice(2048));
        masked = masked.slice(0, 2048) + ` [truncated ${truncatedBytes} bytes]`;
      }
      return masked;
    }
    if (Array.isArray(val)) {
      return val.map((item) => this.sanitizeValue(item));
    }
    if (val !== null && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = this.sanitizeValue(v);
      }
      return out;
    }
    return val;
  }

  async evaluate(call: ToolCall): Promise<PolicyDecision> {
    try {
      if (!call || typeof call !== 'object' || typeof call.name !== 'string') {
        throw new Error('Invalid tool call structure');
      }

      if (this.ctx.callCount !== undefined) {
        this.ctx.callCount++;
      }

      const res = await evaluate(call, this.ctx, this.policy);

      if (this.db) {
        const taskId = this.ctx.taskId!;
        const sanitizedCall = this.sanitizeValue(call) as ToolCall;

        if (res.decision === 'ask') {
          // Create an approval row (kind tool_call)
          await createApproval(this.db, {
            id: crypto.randomUUID(),
            taskId,
            kind: 'tool_call',
            summary: this.maskSecrets(res.reason ?? `Approval required for tool ${call.name}`),
            payload: {
              toolCall: sanitizedCall,
              rule: res.rule,
              reason: res.reason,
            },
            status: 'pending',
          });

          // Log to audit_log
          await appendAudit(this.db, {
            taskId,
            actor: 'agent',
            action: 'policy_ask',
            detail: {
              toolCall: sanitizedCall,
              rule: res.rule,
              reason: res.reason,
            },
          });

          // Log to task_steps if recordTaskStep is enabled
          if (this.recordTaskStep) {
            await appendStep(this.db, {
              id: crypto.randomUUID(),
              taskId,
              idx: this.stepIdx++,
              kind: 'tool_call',
              toolName: call.name,
              input: (sanitizedCall.input ?? {}) as any,
              output: this.sanitizeValue({
                decision: 'ask',
                reason: res.reason ?? 'Approval required',
              }) as any,
              decision: 'ask',
              promptTokens: 0,
              completionTokens: 0,
              costUsd: '0.0000',
            });
          }
        } else if (res.decision === 'deny') {
          // Log to audit_log
          await appendAudit(this.db, {
            taskId,
            actor: 'agent',
            action: 'policy_deny',
            detail: {
              toolCall: sanitizedCall,
              rule: res.rule,
              reason: res.reason,
            },
          });

          // Log to task_steps if recordTaskStep is enabled
          if (this.recordTaskStep) {
            await appendStep(this.db, {
              id: crypto.randomUUID(),
              taskId,
              idx: this.stepIdx++,
              kind: 'tool_call',
              toolName: call.name,
              input: (sanitizedCall.input ?? {}) as any,
              output: this.sanitizeValue({
                decision: 'deny',
                reason: res.reason ?? 'Operation denied',
              }) as any,
              decision: 'deny',
              promptTokens: 0,
              completionTokens: 0,
              costUsd: '0.0000',
            });
          }
        }
      }

      if (res.decision === 'allow') {
        return { action: 'allow' };
      } else if (res.decision === 'ask') {
        return { action: 'ask', reason: res.reason };
      } else {
        return { action: 'deny', reason: res.reason ?? 'Operation denied by policy' };
      }
    } catch (err: any) {
      const reason = `Policy error: ${err?.message || String(err)}`;
      const taskId = this.ctx?.taskId ?? 'unknown-task';

      if (this.db) {
        try {
          const sanitizedCall = this.sanitizeValue(call);
          await appendAudit(this.db, {
            taskId,
            actor: 'agent',
            action: 'policy_deny',
            detail: {
              toolCall: sanitizedCall,
              rule: 'policy_error',
              reason,
            },
          });

          if (this.recordTaskStep) {
            await appendStep(this.db, {
              id: crypto.randomUUID(),
              taskId,
              idx: this.stepIdx++,
              kind: 'tool_call',
              toolName: call?.name ?? 'unknown',
              input: (this.sanitizeValue(call?.input) ?? {}) as any,
              output: { decision: 'deny', reason },
              decision: 'deny',
              promptTokens: 0,
              completionTokens: 0,
              costUsd: '0.0000',
            });
          }
        } catch (auditErr) {
          console.error('Secondary audit log failure in PolicyGate:', auditErr);
        }
      }

      return {
        action: 'deny',
        reason,
      };
    }
  }

  redact(call: ToolCall, resultText: string): string {
    if (!resultText) {
      return resultText;
    }

    let processed = resultText;

    if (call.name === 'grep') {
      const lines = resultText.split('\n');
      const keptLines: string[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;

        // Drop binary-file match lines and error lines
        if (
          line.toLowerCase().includes('binary file matches') ||
          line.toLowerCase().startsWith('grep:')
        ) {
          continue;
        }

        let filePath: string;
        let rest: string;

        const nullIdx = line.indexOf('\0');
        if (nullIdx !== -1) {
          filePath = line.slice(0, nullIdx);
          rest = line.slice(nullIdx + 1);
        } else {
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) {
            // Fail closed: drop every line that cannot be parsed into path + rest
            continue;
          }
          filePath = line.slice(0, colonIdx);
          rest = line.slice(colonIdx + 1);
        }

        // Handle absolute /workspace/... paths in grep output
        let checkPath = filePath;
        if (checkPath.startsWith('/workspace/')) {
          checkPath = checkPath.slice('/workspace/'.length);
        } else if (checkPath === '/workspace') {
          checkPath = '.';
        }

        const check = isPathProtected(checkPath, this.policy, 'grep', this.ctx);
        if (!check.protected) {
          keptLines.push(`${filePath}:${rest}`);
        }
      }

      if (keptLines.length === 0) {
        processed = 'No matches found.';
      } else {
        processed = keptLines.join('\n');
      }
    }

    // Apply maskSecrets to ALL tools
    return this.maskSecrets(processed);
  }
}
