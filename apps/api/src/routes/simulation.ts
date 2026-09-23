import { z } from 'zod';
import type { AgentDraft } from '@winsendotai/ovo-plugin-storage';
import type { Principal } from '../types.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { WorkerTelemetryAdapter } from '@winsendotai/ovo-plugin-observability';
import { withSessionFixtures } from '@winsendotai/ovo-session-host';
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
    queryPage,
    telemetry,
  } = dependencies;
  const simulate = async (principal: Principal, body: z.infer<typeof SimulationBody>) => {
    const release = await store.getRelease(principal.workspaceId, body.releaseId);
    if (!release)
      throw Object.assign(new Error('Release not found'), { statusCode: 404, code: 'not_found' });
    if (
      !body.bindings &&
      release.config.tools.some(
        (tool: { id: string; effect: string }) =>
          release.config.allowedTools.includes(tool.id) && tool.effect === 'write',
      )
    )
      throw Object.assign(new Error('Write tools require explicit simulation fixture bindings'), {
        statusCode: 422,
        code: 'unsafe_simulation',
      });
    const call = await store.createCall({
      workspaceId: principal.workspaceId,
      releaseId: release.id,
      kind: 'simulation',
      status: 'running',
    });
    let sequence = 0;
    const trace = telemetry
      ? new WorkerTelemetryAdapter(telemetry, {
          workspaceId: principal.workspaceId,
          callId: call.id,
          source: 'simulation',
          agentId: release.agentId,
          releaseId: release.id,
          language: release.config.language,
          nextSequence: () => sequence++,
        })
      : undefined;
    trace?.sessionStarted();
    const finishStage = trace?.startStage({ stage: 'simulation.response' });
    try {
      await store.appendCallEvent(principal.workspaceId, call.id, 'simulation.input', {
        input: body.input,
        variables: body.variables,
        bindings: body.bindings ? 'fixture' : 'provider-backed',
      });
      const agent: AgentDraft = {
          id: release.agentId,
          workspaceId: release.workspaceId,
          config: release.config,
          draftVersion: release.draftVersion,
          createdAt: release.createdAt,
          updatedAt: release.createdAt,
        },
        selected = mergeCatalog(
          catalog,
          (await options.createReleasePlugins?.({
            agent,
            sessionId: call.id,
            release,
            fixtureBindings: !!body.bindings,
          })) ?? [],
        ),
        available = body.bindings
          ? withSessionFixtures(release.config, selected, body.bindings)
          : selected;
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
        {
          followUpInputs: body.followUpInputs,
          onTurn: async (turn: { input: string; output: string; epoch: number }) => {
            if (turn.epoch > 0)
              await store.appendCallEvent(principal.workspaceId, call.id, 'simulation.input', {
                input: turn.input,
                speaker: 'customer',
                epoch: turn.epoch,
              });
            await store.appendCallEvent(principal.workspaceId, call.id, 'simulation.output', {
              text: turn.output,
              speaker: 'agent',
              epoch: turn.epoch,
              evidence: 'simulated',
            });
          },
        },
      );
      await store.finishCall(principal.workspaceId, call.id, 'completed');
      finishStage?.('succeeded');
      trace?.sessionEnded('ended');
      return { callId: call.id, kind: 'simulation' as const, output };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Simulation failed';
      finishStage?.('failed');
      trace?.sessionEnded('failed', 'Simulation failed');
      await store.appendCallEvent(principal.workspaceId, call.id, 'simulation.error', { message });
      await store.finishCall(principal.workspaceId, call.id, 'failed');
      throw Object.assign(new Error(message), { statusCode: 422, code: 'simulation_unavailable' });
    }
  };
  app.post('/v1/simulations', async (request: FastifyRequest) =>
    simulate(requireRole(request, 'editor'), SimulationBody.parse(request.body)),
  );
  app.get('/v1/evaluations', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    const page = queryPage(request);
    return await store.listEvaluations(principal.workspaceId, page.limit, page.cursor);
  });
  app.get('/v1/evaluations/:evaluationId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { evaluationId } = z.object({ evaluationId: Id }).parse(request.params),
      evaluation = await store.getEvaluation(principal.workspaceId, evaluationId);
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
      evaluation = await store.createEvaluation({
        workspaceId: principal.workspaceId,
        releaseId: body.releaseId,
        status,
        fixtures: results,
        createdBy: principal.identityId,
      });
    await store.audit({
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
