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
  callCount?: number;
  maxCallsPerTask?: number;
  policyFile?: string;
  auditLocations?: string[];
}

export const FileAskPatternSchema = z.object({
  pattern: z.string(),
  operations: z.array(z.enum(['read', 'write', 'edit', 'list', 'grep'])).default(['write', 'edit']),
  reason: z.string().optional(),
});

export const FileFlagPatternSchema = z.object({
  pattern: z.string(),
  flag: z.string(),
});

export const CommandDenyRuleSchema = z.object({
  name: z.string().optional(),
  argv0: z.string(),
  args: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export const CommandAskRuleSchema = z.object({
  name: z.string().optional(),
  argv0: z.string(),
  subcommands: z.array(z.string()),
  reason: z.string().optional(),
});

export const CommandAllowRuleSchema = z.object({
  argv0: z.string(),
  allowedPatterns: z.array(z.string()),
  reason: z.string().optional(),
});

export const PolicyConfigSchema = z.object({
  version: z.string(),
  limits: z
    .object({
      maxCallsPerTask: z.number().int().positive().default(100),
      perCallOutputSize: z.number().int().positive().default(1024 * 1024),
    })
    .default({ maxCallsPerTask: 100, perCallOutputSize: 1024 * 1024 }),
  files: z
    .object({
      denyPatterns: z.array(z.string()).default([]),
      askPatterns: z.array(FileAskPatternSchema).default([]),
      flagPatterns: z.array(FileFlagPatternSchema).default([]),
    })
    .default({ denyPatterns: [], askPatterns: [], flagPatterns: [] }),
  commands: z
    .object({
      denyList: z.array(CommandDenyRuleSchema).default([]),
      askList: z.array(CommandAskRuleSchema).default([]),
      allowList: z.array(CommandAllowRuleSchema).default([]),
    })
    .default({ denyList: [], askList: [], allowList: [] }),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
export type { ToolCall };
