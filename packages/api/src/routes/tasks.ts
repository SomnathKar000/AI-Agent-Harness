import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { TERMINAL_STATUSES, canTransition } from '@harness/core';
import {
  createTask,
  getRepo,
  getTask,
  getTaskDetail,
  listTasks,
  setTaskFields,
  transitionTask,
  ConcurrentTransitionError,
} from '@harness/db';
import type { ApiDeps } from '../server.js';
import {
  CreateTaskBodySchema,
  ListTasksQuerySchema,
  TaskIdParamsSchema,
} from '../schemas.js';
import { parseOr400, notFound, conflict, sendError, HttpError } from '../errors.js';

export function registerTaskRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/tasks', async (request, reply) => {
    try {
      const query = parseOr400(ListTasksQuerySchema, request.query ?? {}, 'query');
      const tasks = await listTasks(deps.db, query);
      await reply.send({ tasks });
    } catch (err) {
      await sendError(reply, err);
    }
  });

  app.get('/tasks/:id', async (request, reply) => {
    try {
      const { id } = parseOr400(TaskIdParamsSchema, request.params, 'params');
      const detail = await getTaskDetail(deps.db, id);
      if (!detail) throw notFound('task');
      await reply.send(detail);
    } catch (err) {
      await sendError(reply, err);
    }
  });

  app.post('/tasks', async (request, reply) => {
    try {
      const body = parseOr400(CreateTaskBodySchema, request.body, 'body');
      const repo = await getRepo(deps.db, body.repoId);
      if (!repo) throw notFound('repo');

      const taskId = crypto.randomUUID();
      const task = await createTask(deps.db, {
        id: taskId,
        repoId: body.repoId,
        type: body.type,
        title: body.title,
        description: body.description,
        status: 'queued',
        ...(body.maxSteps === undefined ? {} : { maxSteps: body.maxSteps }),
        ...(body.maxCostUsd === undefined ? {} : { maxCostUsd: body.maxCostUsd.toFixed(2) }),
        ...(body.maxMinutes === undefined ? {} : { maxMinutes: body.maxMinutes }),
      });

      // The row exists before the job does, so a worker can never pick up a job whose task
      // is not yet written. Postgres is the source of truth (hard rule 9).
      await deps.queue.enqueue(taskId);

      await reply.code(201).send({ task });
    } catch (err) {
      await sendError(reply, err);
    }
  });

  app.post('/tasks/:id/cancel', async (request, reply) => {
    try {
      const { id } = parseOr400(TaskIdParamsSchema, request.params, 'params');
      const task = await getTask(deps.db, id);
      if (!task) throw notFound('task');
      if (TERMINAL_STATUSES.includes(task.status)) {
        throw conflict(`task is already '${task.status}'`);
      }
      if (!canTransition(task.status, 'cancelled')) {
        throw conflict(`cannot cancel a task in '${task.status}'`);
      }
      try {
        const updated = await transitionTask(deps.db, id, task.status, 'cancelled', 'human');
        await reply.send({ task: updated });
      } catch (err) {
        if (err instanceof ConcurrentTransitionError) {
          throw conflict('task status changed while cancelling; retry');
        }
        throw err;
      }
    } catch (err) {
      await sendError(reply, err);
    }
  });

  app.post('/tasks/:id/retry', async (request, reply) => {
    try {
      const { id } = parseOr400(TaskIdParamsSchema, request.params, 'params');
      const task = await getTask(deps.db, id);
      if (!task) throw notFound('task');
      if (task.status !== 'failed') {
        throw conflict(`only a failed task can be retried; this one is '${task.status}'`);
      }

      try {
        await transitionTask(deps.db, id, 'failed', 'queued', 'human', {
          attempt: task.attempt + 1,
        });
      } catch (err) {
        if (err instanceof ConcurrentTransitionError) {
          throw conflict('task status changed while retrying; retry');
        }
        throw err;
      }

      const updated = await setTaskFields(deps.db, id, {
        attempt: task.attempt + 1,
        failureReason: null,
        containerId: null,
      });
      if (!updated) throw new HttpError(500, 'internal_error', 'task vanished during retry');

      await deps.queue.enqueue(id);
      await reply.send({ task: updated });
    } catch (err) {
      await sendError(reply, err);
    }
  });
}
