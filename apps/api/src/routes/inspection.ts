import type { PriceCard } from '@winsendotai/ovo-plugin-observability';
import {
  allEvidencePages,
  evidenceEngineEvent,
  evidencePaise,
  evidenceRecord,
  projectLatencyBreakdowns,
  projectTranscript,
  simulationTranscriptEvents,
} from '@winsendotai/ovo-plugin-observability';
import type { StoredCallEvent, UsageEntry } from '@winsendotai/ovo-plugin-storage';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getProductionRecordingServices } from '../recording-runtime.ts';
import { publicRecording } from './recording-lifecycle-data.ts';
import { registerCallOutcomes } from './call-outcomes.ts';
export function registerInspectionRoutes(dependencies: any) {
  const {
    app,
    store,
    requireRole,
    queryPage,
    z,
    Id,
    error,
    UsageBody,
    priceUsage,
    summarizeUsage,
  } = dependencies;
  const outcomes = registerCallOutcomes(dependencies);
  app.get('/v1/calls', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer'),
      page = queryPage(request);
    const filters = z
      .object({
        order: z.enum(['asc', 'desc']).default('desc'),
        agentId: Id.optional(),
        engine: z.string().min(1).max(200).optional(),
        carrier: z.string().min(1).max(200).optional(),
        kind: z.enum(['live', 'simulation', 'test']).optional(),
        status: z.string().min(1).max(100).optional(),
      })
      .parse(request.query);
    const calls = await store.listCalls(principal.workspaceId, page.limit, page.cursor, filters);
    return await outcomes.attach(principal.workspaceId, calls, request.log);
  });
  app.get('/v1/calls/:callId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { callId } = z.object({ callId: Id }).parse(request.params),
      call = await store.getCall(principal.workspaceId, callId);
    return call ?? error(reply, 404, 'not_found', 'Call not found');
  });
  app.get('/v1/calls/:callId/events', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { callId } = z.object({ callId: Id }).parse(request.params);
    if (!(await store.getCall(principal.workspaceId, callId)))
      return error(reply, 404, 'not_found', 'Call not found');
    const page = queryPage(request);
    return await store.listCallEvents(principal.workspaceId, callId, page.limit, page.cursor);
  });
  app.get('/v1/calls/:callId/evidence', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer');
    const { callId } = z.object({ callId: Id }).parse(request.params);
    const call = await store.getCall(principal.workspaceId, callId);
    if (!call) return error(reply, 404, 'not_found', 'Call not found');
    const live =
      dependencies.options?.productionRecordingsEnabled && dependencies.ctx
        ? getProductionRecordingServices(dependencies.ctx)?.live
        : undefined;
    const recordings =
      call.kind === 'live' && live
        ? (await live.list(principal.workspaceId, callId, 100)).map(publicRecording)
        : [];
    const [release, events, usage] = await Promise.all([
      fixtureCallRelease(store, principal.workspaceId, call),
      allEvidencePages<StoredCallEvent>((cursor) =>
        store.listCallEvents(principal.workspaceId, callId, 100, cursor),
      ),
      allEvidencePages<UsageEntry>((cursor) =>
        store.listUsage(principal.workspaceId, callId, 100, cursor),
      ),
    ]);
    const timedEvents = events.flatMap((row) => {
      const candidate = row.payload.event;
      return evidenceEngineEvent(candidate)
        ? [
            {
              event: candidate,
              observedAtMs:
                typeof row.payload.atMs === 'number' ? row.payload.atMs : Date.parse(row.at),
            },
          ]
        : [];
    });
    const engineEvents = timedEvents.map((row) => row.event);
    const result = events.find((row) => row.type === 'fixture.result')?.payload;
    const simulationEvents = call.kind === 'simulation' ? simulationTranscriptEvents(events) : [];
    const transcript = projectTranscript([...engineEvents, ...simulationEvents]).map((entry) => ({
      ...entry,
      id: entry.segmentId,
      phase: entry.type.split('.').at(-1),
    }));
    const latency = projectLatencyBreakdowns(
      engineEvents,
      Date.parse(call.createdAt),
      timedEvents.map((row) => row.observedAtMs),
    ).map((entry) => ({ ...entry, stage: entry.turnId, durationMs: entry.totalMs }));
    const estimated = usage.filter((row) => row.state === 'estimated' && row.currency === 'INR');
    const reconciled = usage.filter((row) => row.state === 'reconciled' && row.currency === 'INR');
    const unpriced = [
      ...new Set(
        events
          .filter((row) => row.type === 'fixture.usage' && row.payload.unpriced === true)
          .map((row) => row.payload.key)
          .filter((key): key is string => typeof key === 'string'),
      ),
    ];
    const resolved = evidenceRecord(result?.selections) ? result.selections : undefined;
    const selections = resolved
      ? Object.fromEntries(
          Object.entries(resolved).flatMap(([slot, value]) => {
            if (
              !evidenceRecord(value) ||
              typeof value.id !== 'string' ||
              typeof value.version !== 'string'
            )
              return [];
            return [
              [
                slot,
                { pluginId: value.id, version: value.version, resolvedVersion: value.version },
              ],
            ];
          }),
        )
      : (release?.selections ?? {});
    return {
      call: {
        ...call,
        agentId: release?.agentId,
        outcome:
          evidenceRecord(result?.outcome) && typeof result.outcome.outcome === 'string'
            ? result.outcome.outcome
            : undefined,
      },
      selections,
      transcript,
      latency,
      cost: {
        estimatedPaise: estimated.length ? evidencePaise(estimated) : null,
        reconciledPaise: reconciled.length ? evidencePaise(reconciled) : null,
        unpriced,
        lines: usage,
      },
      ...(result?.recording
        ? { recording: result.recording }
        : recordings.length
          ? { recording: recordings.at(-1) }
          : {}),
      ...(recordings.length ? { recordings } : {}),
      events,
      ...(typeof result?.sttMode === 'string' ? { sttMode: result.sttMode } : {}),
    };
  });
  app.post('/v1/calls/:callId/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin'),
      { callId } = z.object({ callId: Id }).parse(request.params);
    if (!(await store.getCall(principal.workspaceId, callId)))
      return error(reply, 404, 'not_found', 'Call not found');
    const body = UsageBody.parse(request.body),
      priced = priceUsage(
        {
          id: body.id,
          workspaceId: principal.workspaceId,
          sessionId: callId,
          provider: body.provider,
          providerRequestId: body.providerRequestId,
          quantity: body.quantity,
          unit: body.unit,
          state: body.state,
        },
        body.priceCard as PriceCard,
      );
    const entry = await store.addUsage({
      id: priced.id,
      workspaceId: principal.workspaceId,
      callId,
      provider: priced.provider,
      requestId: priced.providerRequestId,
      quantity: priced.quantity,
      unit: priced.unit,
      priceCardId: priced.priceCardId,
      priceCardVersion: priced.priceCardVersion,
      amountMinor: priced.amountMinor,
      currency: priced.currency,
      state: priced.state,
    });
    return reply.code(201).send(entry);
  });
  app.get('/v1/calls/:callId/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { callId } = z.object({ callId: Id }).parse(request.params);
    if (!(await store.getCall(principal.workspaceId, callId)))
      return error(reply, 404, 'not_found', 'Call not found');
    const requested = queryPage(request),
      page = await store.listUsage(
        principal.workspaceId,
        callId,
        requested.limit,
        requested.cursor,
      ),
      summary = summarizeUsage(
        page.items.map((item: any) => ({
          id: item.id,
          workspaceId: item.workspaceId,
          sessionId: item.callId,
          provider: item.provider,
          providerRequestId: item.requestId,
          quantity: item.quantity,
          unit: item.unit,
          state: item.state,
          amountMinor: item.amountMinor,
          currency: item.currency,
          priceCardId: item.priceCardId,
          priceCardVersion: item.priceCardVersion,
          rounding: 'half-up',
        })),
      );
    return { items: page.items, summary, nextCursor: page.nextCursor };
  });
  app.get('/v1/audit', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'admin'),
      page = queryPage(request);
    return await store.listAudit(principal.workspaceId, page.limit, page.cursor);
  });
}
import { fixtureCallRelease } from '../test-call-runtime.ts';
