import { z } from 'zod';

export const ListDirSchema = z.object({
  path: z.string().optional().default('.'),
});

export const ReadFileSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});

export const WriteFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const EditFileSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});

export const GrepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional().default('.'),
});

export const RunCommandSchema = z.object({
  argv: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().optional(),
});

export const FinishSchema = z.object({
  summary: z.string(),
  root_cause: z.string(),
});

export const NeedsInfoSchema = z.object({
  question: z.string(),
});

export type ListDirInput = z.infer<typeof ListDirSchema>;
export type ReadFileInput = z.infer<typeof ReadFileSchema>;
export type WriteFileInput = z.infer<typeof WriteFileSchema>;
export type EditFileInput = z.infer<typeof EditFileSchema>;
export type GrepInput = z.infer<typeof GrepSchema>;
export type RunCommandInput = z.infer<typeof RunCommandSchema>;
export type FinishInput = z.infer<typeof FinishSchema>;
export type NeedsInfoInput = z.infer<typeof NeedsInfoSchema>;
