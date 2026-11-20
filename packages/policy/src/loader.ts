import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { PolicyConfigSchema, type PolicyConfig } from './types.js';

export function resolveDefaultPolicyPath(): string {
  if (process.env.HARNESS_POLICY_PATH) {
    return path.resolve(process.env.HARNESS_POLICY_PATH);
  }
  // Repo root default resolved relative to package location (not from cwd)
  // src/ or dist/ are 3 levels below repo root:
  // packages/policy/src -> packages/policy -> packages -> repo-root
  return path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
}

export function loadPolicy(filePath?: string): PolicyConfig {
  const resolvedPath = filePath ? path.resolve(filePath) : resolveDefaultPolicyPath();

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Policy file not found at: ${resolvedPath}`);
  }

  const rawContent = fs.readFileSync(resolvedPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(rawContent);
  } catch (err) {
    throw new Error(`Invalid YAML in policy file (${resolvedPath}): ${(err as Error).message}`);
  }

  const result = PolicyConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errorMessages = result.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid policy configuration (${resolvedPath}): ${errorMessages}`);
  }

  return result.data;
}
