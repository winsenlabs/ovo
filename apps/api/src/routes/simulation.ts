import { z } from 'zod';
import type { AgentDraft } from '@winsendotai/ovo-plugin-storage';
import type { Principal } from '../types.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';
export function registerSimulationRoutes(dependencies: any) {
  const {
    app,
    store,
    requireRole,
    SimulationBody,
    mergeCatalog,
    catalog,
    options,
    runRelease,
    services,
    createServices,
    EvaluationBody,
    error,
    Id,
  } = dependencies;
  const simulate = async (principal: Principal, body: z.infer<typeof SimulationBody>) => {
    const release = store.getRelease(principal.workspaceId, body.releaseId);
    if (!release)
      throw Object.assign(new Error('Release not found'), { statusCode: 404, code: 'not_found' });
    const call = store.createCall({
      workspaceId: principal.workspaceId,
      releaseId: release.id,
      kind: 'simulation',
      status: 'running',
    });
    store.appendCallEvent(principal.workspaceId, call.id, 'simulation.input', {
      input: body.input,
      variables: body.variables,
    });
    try {
      const agent: AgentDraft = {
          id: release.agentId,
          workspaceId: release.workspaceId,
          config: release.config,
          draftVersion: release.draftVersion,
          createdAt: release.createdAt,
          updatedAt: release.createdAt,
        },
        available = mergeCatalog(
          catalog,
          options.createReleasePlugins?.({ agent, sessionId: call.id }) ?? [],
        );
      for (const locked of release.plugins) {
        const definition = available.find((item: any) => item.manifest.id === locked.id);
        if (!definition || definition.manifest.version !== locked.version)
          throw new Error(`Pinned plugin is not installed: ${locked.id}@${locked.version}`);
      }
      const output = await runRelease(
        release,
        available,
        createServices(release.agentId),
        body.input,
        body.variables,
        call.id,
      );
      store.appendCallEvent(principal.workspaceId, call.id, 'simulation.output', {
        text: output,
        evidence: 'completed',
      });
      store.finishCall(principal.workspaceId, call.id, 'completed');
      return { callId: call.id, kind: 'simulation' as const, output };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Simulation failed';
      store.appendCallEvent(principal.workspaceId, call.id, 'simulation.error', { message });
      store.finishCall(principal.workspaceId, call.id, 'failed');
      throw Object.assign(new Error(message), { statusCode: 422, code: 'simulation_unavailable' });
    }
  };
  app.post('/v1/simulations', async (request: FastifyRequest) =>
    simulate(requireRole(request, 'editor'), SimulationBody.parse(request.body)),
  );
  app.get('/v1/evaluations', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    return { items: store.listEvaluations(principal.workspaceId), nextCursor: null };
  });
  app.get('/v1/evaluations/:evaluationId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { evaluationId } = z.object({ evaluationId: Id }).parse(request.params),
      evaluation = store.getEvaluation(principal.workspaceId, evaluationId);
    return evaluation ?? error(reply, 404, 'not_found', 'Evaluation not found');
  });
  app.post('/v1/evaluations', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'editor'),
      body = EvaluationBody.parse(request.body),
      results = [];
    for (const fixture of body.fixtures) {
      try {
        const result = await simulate(principal, {
          releaseId: body.releaseId,
          input: fixture.input,
          variables: fixture.variables,
        });
        const assertions = {
          expected:
            fixture.expectedOutput === undefined || result.output === fixture.expectedOutput,
          forbidden: fixture.forbiddenOutput.every((value: any) => !result.output.includes(value)),
        };
        results.push({
          ...fixture,
          actualOutput: result.output,
          callId: result.callId,
          assertions,
          passed: assertions.expected && assertions.forbidden,
        });
      } catch (cause) {
        results.push({
          ...fixture,
          error: cause instanceof Error ? cause.message : 'Evaluation failed',
          passed: false,
        });
      }
    }
    const status = results.every((item: any) => item.passed) ? 'passed' : 'failed',
      evaluation = store.createEvaluation({
        workspaceId: principal.workspaceId,
        releaseId: body.releaseId,
        status,
        fixtures: results,
        createdBy: principal.identityId,
      });
    store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'evaluation.create',
      resourceType: 'evaluation',
      resourceId: evaluation.id,
      payload: { releaseId: body.releaseId, status, fixtureCount: results.length },
    });
    return reply.code(201).send(evaluation);
  });
}
