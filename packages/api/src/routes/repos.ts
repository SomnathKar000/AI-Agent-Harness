import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createRepo, listRepos, getRepo } from '@harness/db';
import type { ApiDeps } from '../server.js';
import { CreateRepoBodySchema } from '../schemas.js';
import { parseOr400, notFound, sendError } from '../errors.js';

export function registerRepoRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/repos', async (_request, reply) => {
    try {
      const repos = await listRepos(deps.db);
      await reply.send({ repos });
    } catch (err) {
      await sendError(reply, err);
    }
  });

  app.get('/repos/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const repo = await getRepo(deps.db, id);
      if (!repo) throw notFound('repo');
      await reply.send({ repo });
    } catch (err) {
      await sendError(reply, err);
    }
  });

  app.post('/repos', async (request, reply) => {
    try {
      const body = parseOr400(CreateRepoBodySchema, request.body, 'body');
      const repo = await createRepo(deps.db, {
        id: body.id ?? crypto.randomUUID(),
        name: body.name,
        localPath: body.localPath,
        defaultBranch: body.defaultBranch,
        githubOwner: body.githubOwner ?? null,
        githubRepo: body.githubRepo ?? null,
        testCommand: body.testCommand ?? null,
        lintCommand: body.lintCommand ?? null,
        typecheckCommand: body.typecheckCommand ?? null,
        installCommand: body.installCommand ?? null,
      });
      await reply.code(201).send({ repo });
    } catch (err) {
      await sendError(reply, err);
    }
  });
}
