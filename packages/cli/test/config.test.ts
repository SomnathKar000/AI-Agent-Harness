import { describe, it, expect } from 'vitest';
import { loadCliConfig, DEFAULT_BASE_URL } from '../src/config.js';

describe('loadCliConfig', () => {
  it('throws when HARNESS_TOKEN is missing — no default, fail closed (hard rule 13)', () => {
    expect(() => loadCliConfig({})).toThrow(/HARNESS_TOKEN/);
  });

  it('throws when HARNESS_TOKEN is empty or whitespace', () => {
    expect(() => loadCliConfig({ HARNESS_TOKEN: '' })).toThrow(/HARNESS_TOKEN/);
    expect(() => loadCliConfig({ HARNESS_TOKEN: '   ' })).toThrow(/HARNESS_TOKEN/);
  });

  it('defaults the base url to loopback', () => {
    const cfg = loadCliConfig({ HARNESS_TOKEN: 'a-token-long-enough' });
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('accepts an explicit HARNESS_URL and strips a trailing slash', () => {
    const cfg = loadCliConfig({ HARNESS_TOKEN: 'a-token-long-enough', HARNESS_URL: 'http://127.0.0.1:9999/' });
    expect(cfg.baseUrl).toBe('http://127.0.0.1:9999');
  });

  it('rejects a malformed HARNESS_URL rather than falling back to the default', () => {
    expect(() => loadCliConfig({ HARNESS_TOKEN: 'a-token-long-enough', HARNESS_URL: 'not a url' })).toThrow(/HARNESS_URL/);
  });

  it('does not put the token in the thrown message for a bad url', () => {
    const token = 'tok-SUPERSECRET-value';
    try {
      loadCliConfig({ HARNESS_TOKEN: token, HARNESS_URL: 'nope' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('SUPERSECRET');
    }
  });
});
