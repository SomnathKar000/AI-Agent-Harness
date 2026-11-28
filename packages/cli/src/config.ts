/**
 * CLI configuration. Read from the environment, never from a file the agent can write.
 *
 * `HARNESS_TOKEN` has no default on purpose (hard rule 13): a CLI that silently invented
 * a token would be a CLI that silently talked to nothing, or to something else.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3017';

export interface CliConfig {
  baseUrl: string;
  token: string;
}

export function loadCliConfig(env: Record<string, string | undefined> = process.env): CliConfig {
  const token = (env.HARNESS_TOKEN ?? '').trim();
  if (token.length === 0) {
    throw new Error('HARNESS_TOKEN is not set. Export the same token the API was started with.');
  }

  const raw = (env.HARNESS_URL ?? '').trim();
  if (raw.length === 0) {
    return { baseUrl: DEFAULT_BASE_URL, token };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // The token is never interpolated into this message.
    throw new Error(`HARNESS_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`HARNESS_URL must be http or https, got ${JSON.stringify(parsed.protocol)}`);
  }

  return { baseUrl: raw.replace(/\/+$/, ''), token };
}
