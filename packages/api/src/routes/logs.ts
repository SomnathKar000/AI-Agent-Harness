import type { FastifyInstance } from 'fastify';
import { TERMINAL_STATUSES, type TaskStatus } from '@harness/core';
import { getTask, getStepsAfter } from '@harness/db';
import type { ApiDeps } from '../server.js';
import { TaskIdParamsSchema } from '../schemas.js';
import { parseOr400, notFound, sendError } from '../errors.js';

/**
 * Server-Sent Events for one task: new task_steps and status changes.
 *
 * Polling Postgres rather than LISTEN/NOTIFY keeps the source of truth singular (hard
 * rule 9) and needs no extra connection per listener. Every row it streams was already
 * masked and truncated on the way in (hard rule 14); nothing is re-read from a worktree.
 */
export function registerLogRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const pollMs = deps.logsPollMs ?? 1000;
  const maxMs = deps.logsMaxDurationMs ?? 30 * 60 * 1000;

  app.get('/tasks/:id/logs', async (request, reply) => {
    try {
      const { id } = parseOr400(TaskIdParamsSchema, request.params, 'params');
      const task = await getTask(deps.db, id);
      if (!task) throw notFound('task');

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let closed = false;
      const onClose = (): void => {
        closed = true;
      };
      request.raw.on('close', onClose);

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let lastIdx = 0;
      let lastStatus: TaskStatus | undefined;
      const startedAt = Date.now();

      send('status', { taskId: id, status: task.status });
      lastStatus = task.status;

      while (!closed) {
        const steps = await getStepsAfter(deps.db, id, lastIdx);
        for (const step of steps) {
          send('step', step);
          if (step.idx > lastIdx) lastIdx = step.idx;
        }

        const current = await getTask(deps.db, id);
        if (!current) {
          send('error', { message: 'task disappeared' });
          break;
        }
        if (current.status !== lastStatus) {
          lastStatus = current.status;
          send('status', { taskId: id, status: current.status });
        }

        // A terminal task produces nothing more, and awaiting_approval is where the task
        // waits for a human rather than for the worker: both end the stream.
        if (
          TERMINAL_STATUSES.includes(current.status) ||
          current.status === 'failed' ||
          current.status === 'awaiting_approval'
        ) {
          send('end', { taskId: id, status: current.status });
          break;
        }

        if (Date.now() - startedAt > maxMs) {
          send('end', { taskId: id, status: current.status, reason: 'stream_timeout' });
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      request.raw.off('close', onClose);
      if (!closed) {
        reply.raw.end();
      }
    } catch (err) {
      if (reply.raw.headersSent) {
        reply.raw.end();
        return;
      }
      await sendError(reply, err);
    }
  });
}
