import { describe, it, expect } from 'vitest';
import { calculateCost, parsePricingTable } from '../src/config.js';
import type { Usage } from '../src/types.js';

describe('Cost Calculator unit tests', () => {
  it('calculates cost with placeholder values (returns 0)', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 100,
    };

    const cost = calculateCost('claude-sonnet-5-5', usage);
    expect(cost).toBe(0);
  });

  it('calculates cost using input, output, cache_write, and cache_read per million tokens', () => {
    const pricingTable = {
      'claude-sonnet-5-5': {
        input: 3.0, // $3 per million
        output: 15.0, // $15 per million
        cache_write: 3.75, // $3.75 per million
        cache_read: 0.3, // $0.30 per million
      },
    };

    const usage: Usage = {
      inputTokens: 1_000_000, // $3.00
      outputTokens: 1_000_000, // $15.00
      cacheCreationInputTokens: 1_000_000, // $3.75
      cacheReadInputTokens: 1_000_000, // $0.30
    };

    const cost = calculateCost('claude-sonnet-5-5', usage, pricingTable);
    // 3.00 + 15.00 + 3.75 + 0.30 = 22.05
    expect(cost).toBeCloseTo(22.05, 4);
  });

  it('correctly scales for realistic token amounts including cache creation and read', () => {
    const pricingTable = {
      'claude-sonnet-5-5': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3,
      },
    };

    const usage: Usage = {
      inputTokens: 2500,
      outputTokens: 400,
      cacheCreationInputTokens: 1200,
      cacheReadInputTokens: 800,
    };

    // input: 2500 * 3 / 1e6 = 0.0075
    // output: 400 * 15 / 1e6 = 0.006
    // cache_write: 1200 * 3.75 / 1e6 = 0.0045
    // cache_read: 800 * 0.3 / 1e6 = 0.00024
    // total = 0.01824
    const cost = calculateCost('claude-sonnet-5-5', usage, pricingTable);
    expect(cost).toBeCloseTo(0.01824, 6);
  });

  it('parses pricing table with input, output, cache_write, cache_read', () => {
    const raw = {
      TODO: 'placeholder',
      'claude-sonnet-5-5': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3,
      },
    };

    const parsed = parsePricingTable(raw);
    expect(parsed['claude-sonnet-5-5']).toEqual({
      input: 3.0,
      output: 15.0,
      cache_write: 3.75,
      cache_read: 0.3,
    });
  });
});
