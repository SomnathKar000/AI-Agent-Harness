import type { FastifyReply } from 'fastify';
import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError =>
  new HttpError(404, 'not_found', `${what} not found`);

export const conflict = (message: string): HttpError =>
  new HttpError(409, 'conflict', message);

/**
 * Validates and returns the parsed value, or throws a 400. A malformed body is never
 * partially accepted and no field is defaulted past the schema (hard rule 13).
 */
export function parseOr400<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || what}: ${i.message}`)
      .join('; ');
    throw new HttpError(400, 'invalid_request', detail);
  }
  return result.data;
}

export async function sendError(reply: FastifyReply, err: unknown): Promise<void> {
  if (err instanceof HttpError) {
    await reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }
  // Nothing from an unexpected error reaches the client: a driver error message can carry
  // parameter values (hard rule 14).
  await reply.code(500).send({ error: 'internal_error' });
}
