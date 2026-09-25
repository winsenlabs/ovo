import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Cap } from '@winsendotai/ovo-contracts';
import {
  fixtureEventAudit,
  latestFixtureRelease,
  persistFixtureUsage,
} from '@winsendotai/ovo-fixture-calls';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import {
  createFixtureTelemetry,
  type BufferedTelemetryWriter,
} from '@winsendotai/ovo-plugin-observability';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { Context } from '@winsendotai/ovo-runtime';
import type { Principal } from '../types.ts';
import { persistFixtureRecording } from '../recording-runtime.ts';
import {
  TestCallRuntime,
  fixtureCallsEnvironmentEnabled,
  idempotentFixtureCallId,
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
}

export function registerTestCallRoutes(input: TestCallDependencies): void {
  const runtime =
    input.testCallRuntime ??
    new TestCallRuntime({
      enabled: fixtureCallsEnvironmentEnabled(process.env.OVO_FIXTURE_TEST_CALLS),
      nodeEnv: process.env.NODE_ENV,
    });
  input.app.post(
    '/v1/agents/:id/test-calls',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = input.requireRole(request, 'editor');
      if (!runtime.enabled) return reply.code(404).send({ code: 'fixture_calls_disabled' });
      const { id: agentId } = Params.parse(request.params);
      const body = Body.parse(request.body ?? {});
      const agent = await input.store.getAgent(principal.workspaceId, agentId);
      if (!agent) return reply.code(404).send({ code: 'not_found', message: 'Agent not found' });
      const key = request.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 200))
        return reply.code(400).send({ code: 'invalid_idempotency_key' });
      const callId = key
        ? idempotentFixtureCallId(principal.workspaceId, agentId, key)
        : randomUUID();
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            useDraft: body.useDraft,
            releaseId: body.releaseId ?? 'latest',
            callerScript: body.callerScript ?? 'default',
          }),
        )
        .digest('hex');
      const existing = await input.store.getCall(principal.workspaceId, callId);
      if (existing)
        return existingCall(input.store, principal.workspaceId, existing, fingerprint, reply);
      if (body.useDraft)
        return reply.code(422).send({
          code: 'draft_snapshot_required',
          message: 'Draft test calls require a durable release snapshot',
        });
      const release = body.releaseId
        ? await input.store.getRelease(principal.workspaceId, body.releaseId)
        : await latestFixtureRelease((cursor) =>
            input.store.listReleases(principal.workspaceId, agentId, 100, cursor),
          );
      if (!release || release.agentId !== agentId)
        return reply.code(404).send({ code: 'not_found', message: 'Release not found for agent' });
      let reservation: ReturnType<TestCallRuntime['reserve']>;
      try {
        reservation = runtime.reserve();
      } catch (error) {
        if (error instanceof Error && error.message === 'fixture_calls_capacity')
          return reply.code(429).send({ code: 'fixture_calls_capacity' });
        throw error;
      }
      try {
        await input.store.createCall({
          id: callId,
          workspaceId: principal.workspaceId,
          releaseId: release.id,
          kind: 'test',
          status: 'running',
        });
      } catch (error) {
        reservation.cancel();
        const raced = await input.store.getCall(principal.workspaceId, callId);
        if (raced)
          return existingCall(input.store, principal.workspaceId, raced, fingerprint, reply);
        throw error;
      }
      try {
        await input.store.appendCallEvent(principal.workspaceId, callId, 'fixture.request', {
          fingerprint,
          agentId,
          releaseId: release.id,
        });
      } catch (error) {
        reservation.cancel();
        await input.store.finishCall(principal.workspaceId, callId, 'failed');
        throw error;
      }
      const trace = createFixtureTelemetry(input.telemetry, {
        workspaceId: principal.workspaceId,
        callId,
        agentId,
        releaseId: release.id,
        language: release.config.language,
      });
      trace?.started();
      const fail = async (cause: unknown) => {
        trace?.ended('error:fixture_call_failed');
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
        await fail(error);
        throw error;
      }
      void done
        .then(async (result) => {
          try {
            const recording = release.config.recording
              ? await persistFixtureRecording({
                  context: input.ctx ?? ({ get: () => undefined } as Pick<Context, 'get'>),
                  workspaceId: principal.workspaceId,
                  callId,
                  payload: result.recording,
                })
              : undefined;
            const ledger = input.ctx?.get(Cap.costLedger) as CostLedgerService | undefined;
            await persistFixtureUsage({
              workspaceId: principal.workspaceId,
              callId,
              meters: result.usage,
              priceCards: release.config.costPolicy?.priceCards,
              getPriceCard: ledger?.getPriceCard.bind(ledger),
              createId: randomUUID,
              writePriced: async (priced) => {
                const {
                  sessionId: _sessionId,
                  providerRequestId: requestId,
                  rounding: _rounding,
                  ...record
                } = priced;
                await input.store.addUsage({ ...record, callId, requestId });
              },
              writeMeter: (meter, key, unpriced) => {
                trace?.usage(meter);
                return input.store.appendCallEvent(principal.workspaceId, callId, 'fixture.usage', {
                  ...meter,
                  key,
                  unpriced,
                });
              },
            });
            await input.store.appendCallEvent(principal.workspaceId, callId, 'fixture.result', {
              outcome: result.outcome,
              selections: result.selections,
              sttMode: result.sttMode,
              compatIssues: result.compatIssues,
              ...(recording === undefined ? {} : { recording }),
            });
            await input.store.finishCall(principal.workspaceId, callId, result.status);
            trace?.ended(result.outcome.reason);
          } catch (error) {
            await fail(error);
          }
        }, fail)
        .catch((error) => input.app.log.error({ err: error }, 'fixture call audit failed'));
      return reply.code(202).send({ callId });
    },
  );
}

async function existingCall(
  store: ControlStore,
  workspaceId: string,
  call: { id: string; kind: string },
  fingerprint: string,
  reply: FastifyReply,
) {
  const page = await store.listCallEvents(workspaceId, call.id, 1);
  if (
    call.kind !== 'test' ||
    page.items[0]?.type !== 'fixture.request' ||
    page.items[0].payload.fingerprint !== fingerprint
  )
    return reply.code(409).send({ code: 'idempotency_conflict' });
  return reply.code(202).send({ callId: call.id });
}
