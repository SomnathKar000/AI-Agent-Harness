import crypto from 'node:crypto';
import type { PolicyGate as AgentPolicyGate, PolicyDecision, ToolCall } from '@harness/agent';
import { createApproval, appendAudit, appendStep, type Database } from '@harness/db';
import { loadPolicy } from './loader.js';
import { evaluate } from './evaluator.js';
import type { PolicyConfig, PolicyContext } from './types.js';

export interface PolicyGateOptions {
  policy?: PolicyConfig;
  policyPath?: string;
  ctx: PolicyContext;
  db?: Database;
  recordTaskStep?: boolean;
}

export class PolicyGate implements AgentPolicyGate {
  private policy: PolicyConfig;
  private ctx: PolicyContext;
  private db?: Database;
  private recordTaskStep: boolean;
  private stepIdx: number;

  constructor(options: PolicyGateOptions) {
    this.policy = options.policy ?? loadPolicy(options.policyPath);
    this.ctx = options.ctx;
    this.db = options.db;
    this.recordTaskStep = options.recordTaskStep ?? false;
    this.stepIdx = 1;
  }

  async evaluate(call: ToolCall): Promise<PolicyDecision> {
    if (this.ctx.callCount !== undefined) {
      this.ctx.callCount++;
    }

    const res = await evaluate(call, this.ctx, this.policy);

    if (this.db) {
      const taskId = this.ctx.taskId ?? 'unknown-task';

      if (res.decision === 'ask') {
        // Create an approval row (kind tool_call)
        await createApproval(this.db, {
          id: crypto.randomUUID(),
          taskId,
          kind: 'tool_call',
          summary: res.reason ?? `Approval required for tool ${call.name}`,
          payload: {
            toolCall: call,
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
            toolCall: call,
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
            input: call.input,
            output: { decision: 'ask', reason: res.reason ?? 'Approval required' },
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
            toolCall: call,
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
            input: call.input,
            output: { decision: 'deny', reason: res.reason ?? 'Operation denied' },
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
  }
}
