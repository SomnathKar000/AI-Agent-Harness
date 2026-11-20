import type { ModelPricing, Usage } from './types.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function getAgentModel(): string {
  return process.env.AGENT_MODEL ?? DEFAULT_MODEL;
}

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  [DEFAULT_MODEL]: {
    input: 0,
    output: 0,
    cache_write: 0,
    cache_read: 0,
  },
};

export function parsePricingTable(data: unknown): Record<string, ModelPricing> {
  if (!data || typeof data !== 'object') {
    return DEFAULT_PRICING;
  }
  const table: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key.startsWith('_') || key === 'TODO') continue;
    const val = value as Partial<Record<string, number>>;
    table[key] = {
      input: val.input ?? val.inputTokensPerMillion ?? 0,
      output: val.output ?? val.outputTokensPerMillion ?? 0,
      cache_write: val.cache_write ?? val.cacheWriteTokensPerMillion ?? 0,
      cache_read: val.cache_read ?? val.cacheReadTokensPerMillion ?? 0,
    };
  }
  return table;
}

export function calculateCost(
  model: string,
  usage: Usage,
  pricingTable?: Record<string, ModelPricing>
): number {
  const table = pricingTable ?? DEFAULT_PRICING;
  const pricing = table[model] ?? table[DEFAULT_MODEL] ?? {
    input: 0,
    output: 0,
    cache_write: 0,
    cache_read: 0,
  };

  const inputPrice = pricing.input ?? pricing.inputTokensPerMillion ?? 0;
  const outputPrice = pricing.output ?? pricing.outputTokensPerMillion ?? 0;
  const cacheWritePrice = pricing.cache_write ?? pricing.cacheWriteTokensPerMillion ?? 0;
  const cacheReadPrice = pricing.cache_read ?? pricing.cacheReadTokensPerMillion ?? 0;

  const inputCost = (usage.inputTokens * inputPrice) / 1_000_000;
  const outputCost = (usage.outputTokens * outputPrice) / 1_000_000;
  const cacheWriteCost =
    ((usage.cacheCreationInputTokens ?? 0) * cacheWritePrice) / 1_000_000;
  const cacheReadCost =
    ((usage.cacheReadInputTokens ?? 0) * cacheReadPrice) / 1_000_000;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
