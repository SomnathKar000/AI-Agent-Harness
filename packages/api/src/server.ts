import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Database } from '@harness/db';
import { registerAuth } from './auth.js';
import type { TaskQueuePort } from './queue-port.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerLogRoutes } from './routes/logs.js';

export interface ApiDeps {
  db: Database;
  queue: TaskQueuePort;
  token: string;
  logger?: FastifyServerOptions['logger'];
  /** SSE poll interval. */
  logsPollMs?: number;
  /** Hard ceiling on how long one SSE stream stays open. */
  logsMaxDurationMs?: number;
}

/**
 * Redacts the credential-bearing fields pino would otherwise print verbatim
 * (hard rule 4: the token never reaches a log).
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'request.headers.authorization',
  'headers.authorization',
  'token',
  'config.token',
];

export function buildServer(deps: ApiDeps): FastifyInstance {
  const logger =
    deps.logger === undefined
      ? { level: process.env.LOG_LEVEL ?? 'info', redact: LOG_REDACT_PATHS }
      : deps.logger;

  const app = Fastify({ logger });

  // Default-deny on the instance, before any route is registered.
  registerAuth(app, deps.token);

  registerRepoRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerLogRoutes(app, deps);

  return app;
}
