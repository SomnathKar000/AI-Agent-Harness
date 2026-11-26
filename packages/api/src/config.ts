/**
 * API configuration. Everything here is read by the code (hard rule 16), and a missing or
 * malformed value throws rather than taking a default (hard rule 13).
 */

/**
 * The API is local-only. This is a constant, not a setting: there is deliberately no
 * environment variable that can bind it to a public interface. The bearer token is a thin
 * shared secret, not an authentication system, and it is not meant to face a network.
 */
export const API_HOST = '127.0.0.1';

export const DEFAULT_PORT = 3017;

/** Short enough to type, long enough that guessing is not a strategy. */
export const MIN_TOKEN_LENGTH = 16;

export interface ApiConfig {
  host: string;
  port: number;
  token: string;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const token = env.HARNESS_TOKEN?.trim() ?? '';
  if (token.length === 0) {
    throw new Error(
      'HARNESS_TOKEN is required. The API refuses to start without a bearer token.'
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `HARNESS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters, got ${token.length}.`
    );
  }

  let port = DEFAULT_PORT;
  const rawPort = env.HARNESS_PORT?.trim();
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`HARNESS_PORT must be an integer between 1 and 65535, got '${rawPort}'`);
    }
    port = parsed;
  }

  return { host: API_HOST, port, token };
}
