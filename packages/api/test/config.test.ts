import { describe, it, expect } from 'vitest';
import { loadApiConfig, API_HOST, MIN_TOKEN_LENGTH } from '../src/config.js';

const VALID_TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH);

describe('API configuration fails closed', () => {
  it('binds to loopback', () => {
    expect(API_HOST).toBe('127.0.0.1');
  });

  it('accepts a long enough token', () => {
    const config = loadApiConfig({ HARNESS_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
    expect(config.token).toBe(VALID_TOKEN);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBeGreaterThan(0);
  });

  it.each([
    ['missing', {}],
    ['empty', { HARNESS_TOKEN: '' }],
    ['whitespace', { HARNESS_TOKEN: '        ' }],
    ['too short', { HARNESS_TOKEN: 'short' }],
  ])('throws when HARNESS_TOKEN is %s', (_label, env) => {
    expect(() => loadApiConfig(env as NodeJS.ProcessEnv)).toThrow();
  });

  it('throws on a non-numeric port rather than falling back to the default', () => {
    expect(() =>
      loadApiConfig({ HARNESS_TOKEN: VALID_TOKEN, HARNESS_PORT: 'eighty' } as NodeJS.ProcessEnv)
    ).toThrow();
  });

  it('throws on an out-of-range port', () => {
    expect(() =>
      loadApiConfig({ HARNESS_TOKEN: VALID_TOKEN, HARNESS_PORT: '70000' } as NodeJS.ProcessEnv)
    ).toThrow();
  });
});
