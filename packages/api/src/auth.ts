import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const BEARER_PREFIX = 'Bearer ';

/**
 * Constant-time comparison that does not leak the expected length either: both sides are
 * hashed to a fixed width first, so timingSafeEqual always gets equal-length buffers.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Registers bearer-token auth as an instance-wide hook.
 *
 * Deliberately not a per-route preHandler: a route added later would simply forget it, and
 * a forgotten check is an open endpoint. `packages/api/test/auth.test.ts` enumerates the
 * instance's registered routes and fails if any answers something other than 401 while
 * unauthenticated.
 */
export function registerAuth(app: FastifyInstance, expectedToken: string): void {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    throw new Error('registerAuth requires a non-empty token');
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      // The rejected value is never echoed back or logged.
      await reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
    const provided = header.slice(BEARER_PREFIX.length);
    if (provided.length === 0 || !tokensMatch(provided, expectedToken)) {
      await reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
  });
}
