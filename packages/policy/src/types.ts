import { z } from 'zod';
import type { ToolCall } from '@harness/agent';

export type PolicyAction = 'allow' | 'ask' | 'deny';

export interface EvaluationResult {
  decision: PolicyAction;
  reason?: string;
  rule?: string;
  flag?: string;
}

export interface PolicyContext {
  workspaceRoot: string;
  taskId?: string;
  callCount: number;
  maxCallsPerTask?: number;
  policyFile?: string;
  auditLocations?: string[];
}

export const FileAskPatternSchema = z
  .object({
    pattern: z.string(),
    operations: z
      .array(z.enum(['read', 'write', 'edit', 'list', 'grep']))
      .default(['write', 'edit']),
    reason: z.string().optional(),
  })
  .strict();

export const PolicyConfigSchema = z
  .object({
    version: z.string(),
    limits: z
      .object({
        maxCallsPerTask: z.number().int().positive().default(100),
      })
      .strict()
      .default({ maxCallsPerTask: 100 }),
    files: z
      .object({
        denyPatterns: z.array(z.string()).default([]),
        askPatterns: z.array(FileAskPatternSchema).default([]),
      })
      .strict()
      .default({ denyPatterns: [], askPatterns: [] }),
  })
  .strict();

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
export type { ToolCall };
