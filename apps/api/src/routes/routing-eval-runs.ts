import { z } from 'zod';
import {
  EvalRunRequest,
  ROUTING_EVAL_LIMITS,
  RoutingEvalCase,
  type RoutingEvalRun,
} from '@winsendotai/ovo-contracts';
import { releaseSource, routerInfo } from '../routing-simulate-target.ts';
import {
  routed,
  routingPage,
  sendError,
  withinRate,
  type RoutingR4Dependencies,
} from './routing-support.ts';

const RunParams = z.object({ runId: z.uuid() });
/** A run that takes longer than this is refused rather than half scored. */
const WALL_MS = 20_000;

/** The first case that does not parse, with its position, for a 422 that says which. */
function firstBadCase(cases: unknown): { index: number; issues: z.core.$ZodIssue[] } | undefined {
  if (!Array.isArray(cases)) return undefined;
  for (const [index, found] of cases.entries()) {
    const parsed = RoutingEvalCase.safeParse(found);
    if (!parsed.success) return { index, issues: parsed.error.issues };
  }
}

/**
 * Server-run routing eval (R4 design 6): a corpus of scripted callers scored against one routing
 * release with the scorer the CLI uses, persisted with its scorecard so the console can chart
 * accuracy across runs. Offline only: engine answers are the corpus's own, so a run scores the tree,
 * the rules and the pools, not a model. Cases are authored, synthetic utterances kept with the run
 * until it is deleted.
 */
export function registerRoutingEvalRunRoutes(input: RoutingR4Dependencies): void {
  const { app, audit } = input;
  const notFound = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 404, 'routing_eval_run_not_found', 'Routing eval run not found');

  app.post(
    '/v1/routing/eval-runs',
    { bodyLimit: ROUTING_EVAL_LIMITS.bodyBytes },
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      if (!withinRate(reply, input.limiter, principal)) return;
      const bad = firstBadCase((request.body as { cases?: unknown } | undefined)?.cases);
      if (bad)
        return sendError(reply, 422, 'routing_eval_invalid', `Case ${bad.index} is invalid`, bad);
      const parsed = EvalRunRequest.safeParse(request.body ?? {});
      if (!parsed.success)
        return sendError(reply, 422, 'routing_eval_invalid', 'The eval run request is invalid', {
          issues: parsed.error.issues,
        });
      if (!input.simulator)
        return sendError(
          reply,
          503,
          'routing_simulator_unavailable',
          'The router cannot score here',
        );
      const body = parsed.data;
      const resolved = await releaseSource(routing, body.routingReleaseId);
      if (!resolved.ok) return sendError(reply, resolved.status, resolved.code, resolved.message);
      const { snapshot, source } = resolved.found;
      const flags = {
        transferEnabled: body.assume.transferEnabled ?? input.transferEnabled,
        humanQueueEnabled:
          body.assume.humanQueueEnabled ??
          (input.humanQueueEnabled === true && input.operations !== undefined),
      };
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const scored = await Promise.race([
        input.simulator.scoreRoutingCorpus({
          snapshot,
          cases: body.cases,
          name: body.name,
          engineMode: 'recorded',
          flags,
          router: await routerInfo(input.store, principal.workspaceId, snapshot),
          routingReleaseId: source.routingReleaseId,
        }),
        new Promise<'slow'>((resolve) => {
          timer = setTimeout(() => resolve('slow'), WALL_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (scored === 'slow')
        return sendError(reply, 422, 'routing_eval_too_slow', 'The corpus took too long to score');
      // The release is what was scored; the scorer reports the snapshot it was handed.
      const scorecard = {
        ...scored,
        routing: {
          pointId: source.pointId,
          routingReleaseId: source.routingReleaseId,
          digest: source.digest,
        },
      };
      const run = await routing.evalRuns.create({
        routingReleaseId: body.routingReleaseId,
        name: body.name,
        corpusDigest: input.simulator.routingCorpusDigest(body.cases),
        scorecard,
        corpus: body.cases,
        createdBy: principal.identityId,
      });
      if (!run)
        return sendError(reply, 404, 'routing_release_not_found', 'Routing release not found');
      await audit(principal, 'routing.eval_run.create', 'routing_eval_run', run.id, {
        name: run.name,
        routingReleaseId: run.routingReleaseId,
        cases: run.caseCount,
        corpusDigest: run.corpusDigest,
        passed: run.headline.passed,
      });
      request.log.info(
        {
          event: 'routing_eval_run',
          cases: run.caseCount,
          ms: Date.now() - started,
          passed: run.headline.passed,
        },
        'routing eval run',
      );
      const created: RoutingEvalRun = run;
      return reply.code(201).send(created);
    }),
  );

  app.get(
    '/v1/routing/eval-runs',
    routed(input, 'viewer', ({ request, routing }) =>
      routingPage(request, (limit, cursor) => routing.evalRuns.list(limit, cursor)),
    ),
  );

  app.get(
    '/v1/routing/eval-runs/:runId',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const { runId } = RunParams.parse(request.params);
      return (await routing.evalRuns.get(runId)) ?? notFound(reply);
    }),
  );

  app.delete(
    '/v1/routing/eval-runs/:runId',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { runId } = RunParams.parse(request.params);
      if (!(await routing.evalRuns.softDelete(runId))) return notFound(reply);
      await audit(principal, 'routing.eval_run.delete', 'routing_eval_run', runId);
      return reply.code(204).send();
    }),
  );
}
