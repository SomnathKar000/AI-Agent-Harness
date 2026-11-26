import type { FastifyInstance } from 'fastify';
import { maskAndTruncate } from '@harness/core';
import {
  appendAudit,
  decideApproval,
  getApproval,
  listApprovals,
} from '@harness/db';
import type { ApiDeps } from '../server.js';
import {
  ApprovalIdParamsSchema,
  DecideApprovalBodySchema,
  ListApprovalsQuerySchema,
} from '../schemas.js';
import { parseOr400, notFound, conflict, sendError } from '../errors.js';

const MAX_NOTE_CHARS = 2000;

export function registerApprovalRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/approvals', async (request, reply) => {
    try {
      const query = parseOr400(ListApprovalsQuerySchema, request.query ?? {}, 'query');
      const approvals = await listApprovals(deps.db, query);
      await reply.send({ approvals });
    } catch (err) {
      await sendError(reply, err);
    }
  });

  app.post('/approvals/:id/decide', async (request, reply) => {
    try {
      const { id } = parseOr400(ApprovalIdParamsSchema, request.params, 'params');
      const body = parseOr400(DecideApprovalBodySchema, request.body, 'body');

      const approval = await getApproval(deps.db, id);
      if (!approval) throw notFound('approval');
      if (approval.status !== 'pending') {
        throw conflict(`approval is already '${approval.status}'`);
      }

      // A human-typed note goes into the database like anything else: masked, then
      // truncated, then written (hard rule 14). The API holds no secret registry for this
      // task, so masking has nothing to remove; the truncation bound still applies.
      const note = body.note === undefined ? undefined : maskAndTruncate(body.note, [], MAX_NOTE_CHARS);

      const updated = await decideApproval(
        deps.db,
        id,
        body.approved ? 'approved' : 'rejected',
        note
      );

      await appendAudit(deps.db, {
        taskId: approval.taskId,
        actor: 'human',
        action: 'approval_decided',
        detail: {
          approvalId: id,
          kind: approval.kind,
          decision: body.approved ? 'approved' : 'rejected',
          note: note ?? null,
        },
      });

      await reply.send({ approval: updated });
    } catch (err) {
      await sendError(reply, err);
    }
  });
}
