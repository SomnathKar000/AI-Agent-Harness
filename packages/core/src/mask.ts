/**
 * The single mask-then-truncate used before anything reaches the database.
 *
 * Order matters and is fixed: mask secrets first, truncate second, write third. Truncating
 * first could cut a secret in half and let the halves through unmasked.
 *
 * Lifted unchanged from PolicyGate (packages/policy/src/gate.ts) so the policy gate and the
 * verifier share one implementation instead of two copies that can drift.
 */

export const DEFAULT_MAX_DB_VALUE_LENGTH = 2048;

/** Secrets shorter than this are not masked: they match too much ordinary text. */
export const MIN_SECRET_LENGTH = 8;

export function maskSecrets(text: string, secrets: readonly string[]): string {
  if (!text || secrets.length === 0) return text;
  let result = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }
  return result;
}

export function truncateForDb(
  text: string,
  maxLength: number = DEFAULT_MAX_DB_VALUE_LENGTH
): string {
  if (text.length <= maxLength) return text;
  const truncatedBytes = Buffer.byteLength(text.slice(maxLength));
  return text.slice(0, maxLength) + ` [truncated ${truncatedBytes} bytes]`;
}

/** Mask every secret, then truncate. The only function callers should need. */
export function maskAndTruncate(
  text: string,
  secrets: readonly string[],
  maxLength: number = DEFAULT_MAX_DB_VALUE_LENGTH
): string {
  return truncateForDb(maskSecrets(text, secrets), maxLength);
}
