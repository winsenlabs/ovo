import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FixtureAdmissions,
  callerScriptFitsWallTimeout,
  fixtureEventAudit,
  fixtureRequestFingerprint,
  latestFixtureRelease,
} from '@winsendotai/ovo-fixture-calls';
import {
  createFixtureTelemetry,
  type BufferedTelemetryWriter,
} from '@winsendotai/ovo-plugin-observability';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { Context, PluginDefinition } from '@winsendotai/ovo-runtime';
import type { SessionDefaults } from '@winsendotai/ovo-session-host';
import type { DefaultSessionOptions } from '../session-factory.ts';
import type { Principal } from '../types.ts';
import {
  TestCallRuntime,
  fixtureCallsEnvironmentEnabled,
  idempotentFixtureCallId,
  fixtureAdmissionStore,
  fixtureDraft,
  persistFixtureResult,
} from '../test-call-runtime.ts';

const Params = z.object({ id: z.uuid() });
const CallerScript = z.object({
  turns: z
    .array(
      z.object({
        atMs: z.number().int().min(0).max(120_000),
        say: z.string().max(10_000).optional(),
        dtmf: z.string().max(100).optional(),
        silenceMs: z.number().int().min(0).max(120_000).optional(),
      }),
    )
    .max(100),
});
const Body = z.object({
  useDraft: z.boolean().default(false),
  releaseId: z.uuid().optional(),
  callerScript: z.union([z.literal('default'), CallerScript]).optional(),
});

interface TestCallDependencies {
  app: FastifyInstance;
  store: ControlStore;
  requireRole: (request: FastifyRequest, role: 'editor') => Principal;
  testCallRuntime?: TestCallRuntime;
  ctx?: Pick<Context, 'get'>;
  telemetry?: BufferedTelemetryWriter;
  catalog?: readonly PluginDefinition[];
  distributionDefaults?: SessionDefaults;
  options?: { defaultSession?: DefaultSessionOptions };
}

export function registerTestCallRoutes(input: TestCallDependencies): void {
  const runtime =
    input.testCallRuntime ??
    new TestCallRuntime({
      enabled: fixtureCallsEnvironmentEnabled(process.env.OVO_FIXTURE_TEST_CALLS),
      nodeEnv: process.env.NODE_ENV,
    });
  const admissions = new FixtureAdmissions<{ statusCode: number; body: Record<string, unknown> }>();
  input.app.post(
    '/v1/agents/:id/test-calls',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = input.requireRole(request, 'editor');
      if (!runtime.enabled) return reply.code(404).send({ code: 'fixture_calls_disabled' });
      const { id: agentId } = Params.parse(request.params);
      const body = Body.parse(request.body ?? {});
      if (
        body.callerScript &&
        body.callerScript !== 'default' &&
        !callerScriptFitsWallTimeout(body.callerScript, runtime.wallTimeoutMs)
      )
        return reply.code(422).send({ code: 'caller_script_exceeds_timeout' });
      const agent = await input.store.getAgent(principal.workspaceId, agentId);
      if (!agent) return reply.code(404).send({ code: 'not_found', message: 'Agent not found' });
      const key = request.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 200))
        return reply.code(400).send({ code: 'invalid_idempotency_key' });
      const callId = key
        ? idempotentFixtureCallId(principal.workspaceId, agentId, key)
        : randomUUID();
      const fingerprint = fixtureRequestFingerprint(body);
      const committed = await input.store.getCall(principal.workspaceId, callId);
      if (committed) {
        const response = await existingCall(
          input.store,
          principal.workspaceId,
          committed,
          fingerprint,
        );
        return reply.code(response.statusCode).send(response.body);
      }
      const response = await admissions.run(callId, fingerprint, async () => {
        const respond = (statusCode: number, body: Record<string, unknown>) => ({
          statusCode,
          body,
        });
        const existing = await input.store.getCall(principal.workspaceId, callId);
        if (existing)
          return existingCall(input.store, principal.workspaceId, existing, fingerprint);
        if (body.useDraft && body.releaseId)
          return respond(400, { code: 'ambiguous_fixture_source' });
        let release = body.useDraft
          ? undefined
          : body.releaseId
            ? await input.store.getRelease(principal.workspaceId, body.releaseId)
            : await latestFixtureRelease((cursor) =>
                input.store.listReleases(principal.workspaceId, agentId, 100, cursor),
              );
        if (!body.useDraft && (!release || release.agentId !== agentId))
          return respond(404, { code: 'not_found', message: 'Release not found for agent' });
        let reservation: ReturnType<TestCallRuntime['reserve']>;
        try {
          reservation = runtime.reserve();
        } catch (error) {
          if (error instanceof Error && error.message === 'fixture_calls_capacity')
            return respond(429, { code: 'fixture_calls_capacity' });
          throw error;
        }
        try {
          const storage = fixtureAdmissionStore(input.store);
          const admitted = await storage.createFixtureCall({
            workspaceId: principal.workspaceId,
            id: callId,
            agentId,
            fingerprint,
            ...(body.useDraft
              ? { draft: await fixtureDraft(input, agent, principal.identityId) }
              : { releaseId: release!.id }),
          });
          if (!admitted.created) {
            reservation.cancel();
            return respond(202, { callId: admitted.call.id });
          }
          release = admitted.release;
        } catch (error) {
          reservation.cancel();
          throw error;
        }
        const trace = createFixtureTelemetry(input.telemetry, {
          workspaceId: principal.workspaceId,
          callId,
          agentId,
          releaseId: release.id,
          language: release.config.language,
        });
        const fail = async (cause: unknown) => {
          try {
            trace?.ended('error:fixture_call_failed');
          } catch (error) {
            input.app.log.error({ err: error }, 'fixture telemetry failed');
          }
          try {
            await input.store.appendCallEvent(principal.workspaceId, callId, 'fixture.error', {
              message: cause instanceof Error ? cause.message : 'Fixture call failed',
            });
          } finally {
            await input.store.finishCall(principal.workspaceId, callId, 'failed');
          }
        };
        let done: Promise<import('@winsendotai/ovo-fixture-calls').FixtureCallResult>;
        try {
          trace?.started();
          done = reservation.start(
            { callId, release, callerScript: body.callerScript ?? 'default' },
            (row) => {
              trace?.event(row);
              const { type, payload } = fixtureEventAudit(row);
              return input.store
                .appendCallEvent(principal.workspaceId, callId, type, payload)
                .then(() => undefined);
            },
          );
        } catch (error) {
          reservation.cancel();
          await fail(error);
          throw error;
        }
        void done
          .then(async (result) => {
            try {
              await persistFixtureResult({
                result,
                release,
                workspaceId: principal.workspaceId,
                callId,
                store: input.store,
                ctx: input.ctx,
                trace,
              });
            } catch (error) {
              await fail(error);
            }
          }, fail)
          .catch((error) => input.app.log.error({ err: error }, 'fixture call audit failed'));
        return respond(202, { callId });
      });
      return reply.code(response.statusCode).send(response.body);
    },
  );
}

async function existingCall(
  store: ControlStore,
  workspaceId: string,
  call: { id: string; kind: string },
  fingerprint: string,
) {
  const page = await store.listCallEvents(workspaceId, call.id, 1);
  if (
    call.kind !== 'test' ||
    page.items[0]?.type !== 'fixture.request' ||
    page.items[0].payload.fingerprint !== fingerprint
  )
    return { statusCode: 409, body: { code: 'idempotency_conflict' } };
  return { statusCode: 202, body: { callId: call.id } };
}
