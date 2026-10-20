import {
  RoutingSimulationResult,
  SIMULATION_LIMITS,
  SIMULATION_SCHEMA,
  SimulationRequest,
  type SimulationWarning,
} from '@winsendotai/ovo-contracts';
import type { FastifyReply } from 'fastify';
import { loadMap, routerInfo, simulationSource } from '../routing-simulate-target.ts';
import { isSimulationInputError } from '../routing-simulator.ts';
import { publishContext } from './routing-points.ts';
import { routed, sendError, withinRate, type RoutingR4Dependencies } from './routing-support.ts';

const ENGINE_KEYS = ['decision', 'llm', 'external'] as const;

/** The engines a request asks to run for real, and what in this installation refuses them. */
function liveRefusal(input: RoutingR4Dependencies, request: SimulationRequest) {
  const asked = ENGINE_KEYS.filter((key) => request.engines.mode[key] === 'live');
  const missing = asked.filter((key) =>
    key === 'external'
      ? !(input.externalEnabled && input.liveEngines?.external)
      : !(input.simulateLiveEnabled === true && input.liveEngines?.llm),
  );
  return { asked, missing };
}

/**
 * `POST /v1/routing/simulate` (R4 design 5.3, 6): runs a scripted caller through a routing release,
 * or an unpublished draft resolved as publish resolves it, with no call placed. The router is the
 * one the worker runs (`plugin-router`); rules run for real and the other engines answer as the
 * request scripts them unless an admin opts a live one in. Editors may simulate; a live engine
 * needs an admin, its flag and the factory that composes it, and is refused (never mocked) when any
 * is missing. The audit records counts and modes, never the caller's words or numbers.
 */
export function registerRoutingSimulateRoutes(input: RoutingR4Dependencies): void {
  input.app.post(
    '/v1/routing/simulate',
    { bodyLimit: SIMULATION_LIMITS.bodyBytes },
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      if (!withinRate(reply, input.limiter, principal)) return;
      const parsed = SimulationRequest.safeParse(request.body ?? {});
      if (!parsed.success)
        return sendError(
          reply,
          422,
          'routing_simulate_invalid',
          'The simulation request is invalid',
          {
            issues: parsed.error.issues,
          },
        );
      if (!input.simulator)
        return sendError(
          reply,
          503,
          'routing_simulator_unavailable',
          'The router cannot simulate here',
        );
      const { target, ...rest } = parsed.data;
      const live = liveRefusal(input, parsed.data);
      if (live.asked.length) {
        input.requireRole(request, 'admin');
        if (live.missing.length)
          return sendError(
            reply,
            409,
            'simulate_live_unavailable',
            'A live engine was asked for and this installation does not offer it',
            { engines: live.missing },
          );
        if (rest.turns.length > SIMULATION_LIMITS.liveTurns)
          return sendError(
            reply,
            422,
            'routing_simulate_invalid',
            `A live simulation runs at most ${SIMULATION_LIMITS.liveTurns} caller turns`,
          );
      }
      const resolved = await simulationSource(
        routing,
        publishContext(input, principal, routing),
        target,
      );
      if (!resolved.ok)
        return sendError(reply, resolved.status, resolved.code, resolved.message, resolved.extra);
      const { snapshot, source } = resolved.found;
      const warnings: SimulationWarning[] = [...resolved.found.warnings];
      const server = {
        transferEnabled: input.transferEnabled,
        humanQueueEnabled: input.humanQueueEnabled === true && input.operations !== undefined,
      };
      const flags = {
        transferEnabled: rest.assume.transferEnabled ?? server.transferEnabled,
        humanQueueEnabled: rest.assume.humanQueueEnabled ?? server.humanQueueEnabled,
      };
      for (const key of ['transferEnabled', 'humanQueueEnabled'] as const)
        if (flags[key] !== server[key])
          warnings.push({
            code: 'assumption_differs',
            message: `This run assumed ${key} ${flags[key]}; the server has it ${server[key]}.`,
          });
      let load: Record<string, number> | undefined;
      if (rest.load === 'live')
        try {
          load = loadMap(await routing.claims.activeByPool(Object.keys(snapshot.pools)));
        } catch (error) {
          request.log.warn({ err: error }, 'routing simulate: claim load unavailable');
          warnings.push({
            code: 'load_unavailable',
            message: 'Active claims could not be read; the run assumed every member idle.',
          });
        }
      const started = Date.now();
      const engines = live.asked.length
        ? await input.liveEngines!.open({
            workspaceId: principal.workspaceId,
            routerReleaseId: snapshot.router.release.releaseId,
          })
        : undefined;
      try {
        const run = await input.simulator.simulateRoute({
          snapshot,
          request: rest,
          now: rest.call.at ? Date.parse(rest.call.at) : (input.clock ?? Date.now)(),
          router: await routerInfo(input.store, principal.workspaceId, snapshot),
          flags,
          ...(load ? { load } : {}),
          ...(engines ? { live: engines.ports } : {}),
          ...(source.routingReleaseId ? { routingReleaseId: source.routingReleaseId } : {}),
          signal: abortWhenClosed(reply),
        });
        const result: RoutingSimulationResult = {
          schema: SIMULATION_SCHEMA,
          at: run.at,
          source,
          engineModes: run.engineModes,
          assumed: run.assumed,
          turns: run.turns,
          outcome: run.outcome,
          pools: run.pools,
          warnings: [...warnings, ...run.warnings],
          stats: run.stats,
        };
        await input.audit(principal, 'routing.simulate', 'routing_point', source.pointId, {
          target: target.kind,
          routingReleaseId: source.routingReleaseId,
          turns: rest.turns.length,
          answers: rest.engines.answers.length,
          modes: run.engineModes,
          load: rest.load,
          status: run.outcome.status,
          liveCalls: run.stats.liveCalls,
        });
        request.log.info(
          {
            event: 'routing_simulate',
            ms: Date.now() - started,
            turns: run.stats.routerTurns,
            liveCalls: run.stats.liveCalls,
            status: run.outcome.status,
          },
          'routing simulate',
        );
        return result;
      } catch (error) {
        if (!isSimulationInputError(error)) throw error;
        return error.code === 'live_engine_unavailable'
          ? sendError(reply, 409, 'simulate_live_unavailable', error.message)
          : sendError(reply, 422, 'routing_simulate_invalid', error.message);
      } finally {
        await engines?.dispose();
      }
    }),
  );
}

/** Stops the run when the client goes away, so a closed tab does not keep a live engine running. */
function abortWhenClosed(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  // The response closes unfinished only when the client goes away (the request's own `close` fires
  // as soon as its body is read).
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort(new Error('client closed'));
  });
  return controller.signal;
}
