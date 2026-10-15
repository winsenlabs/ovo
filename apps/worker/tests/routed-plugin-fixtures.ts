import {
  Cap,
  MULAW_8K,
  outcomeFor,
  type EndReason,
  type EngineEvent,
  type EventSink,
  type MediaDuplex,
  type RoutingHost,
  type SegmentHandoffPort,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';

/** One engine the fixture composed: its row config, its media and its behaviour. */
export interface FixtureEngine {
  releaseId: string;
  config: Record<string, unknown>;
  media: MediaDuplex;
  behavior: unknown;
  started: boolean;
  disposed?: EndReason;
  emit(event: EngineEvent): void;
  /** Ends like the native engine: media first. */
  complete(reason?: EndReason): Promise<void>;
}

/** The router as the router lane's behaviour sees the host: what it was configured and given. */
export interface FixtureRouter {
  config: Record<string, unknown>;
  host: RoutingHost;
  handoff: SegmentHandoffPort;
  events: EventSink;
}

export function fixturePlugins(engines: FixtureEngine[], routers: FixtureRouter[]) {
  const llm = definePlugin(
    {
      id: 'fixture-llm',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'llm',
      provider: 'fixture',
      provides: [Cap.inference],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: { tools: true, streaming: false },
      meters: [{ key: 'fixture.llm', unit: 'input_tokens', label: 'Input', role: 'llm' }],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['llm@1'],
    },
    (ctx) => {
      ctx.provide(Cap.inference, { generate: async () => ({ kind: 'text', text: '' }) });
    },
  );
  const engine = definePlugin(
    {
      id: 'fixture-engine',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture',
      provides: [`${Cap.engine}@2`],
      requires: [Cap.behavior, Cap.media],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: {
        turnDetection: ['provider'],
        bargeIn: true,
        dtmf: true,
        confirmedPlayback: true,
        ownsProviders: false,
        formats: [MULAW_8K],
        consumesTurnDetector: false,
      },
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['engine@1'],
    },
    (ctx, config) => {
      const media = ctx.get(Cap.media) as MediaDuplex;
      const listeners = new Set<(event: EngineEvent) => void>();
      let ended!: (outcome: { reason: EndReason; outcome: ReturnType<typeof outcomeFor> }) => void;
      let stopping: Promise<{ reason: EndReason; outcome: ReturnType<typeof outcomeFor> }>;
      const dispose = (reason: EndReason) =>
        (stopping ??= (async () => {
          record.disposed = reason;
          await media.close(reason);
          const outcome = { reason, outcome: outcomeFor(reason) };
          ended(outcome);
          return outcome;
        })());
      const record: FixtureEngine = {
        releaseId: String((config.engine as { release?: string } | undefined)?.release),
        config,
        media,
        behavior: ctx.get(Cap.behavior),
        started: false,
        emit: (event) => listeners.forEach((listener) => listener(event)),
        complete: async (reason = 'behavior_completed') => void (await dispose(reason)),
      };
      engines.push(record);
      ctx.provide(Cap.engine, {
        start: async () => {
          record.started = true;
          media.onClose((reason) => void dispose(reason));
        },
        dispose,
        ended: new Promise((resolve) => (ended = resolve)),
        subscribe: (listener: (event: EngineEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ingressStats: {
          ...{ acceptedFrames: 0, acceptedBytes: 0, pendingFrames: 0 },
          ...{ pendingBytes: 0, overflows: 0 },
        },
      });
    },
  );
  const router = definePlugin(
    {
      id: '@fixture/router',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.behavior],
      requires: [Cap.routing, Cap.segmentHandoff, Cap.events],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx, config) => {
      routers.push({
        config,
        host: ctx.get(Cap.routing) as RoutingHost,
        handoff: ctx.get(Cap.segmentHandoff) as SegmentHandoffPort,
        events: ctx.get(Cap.events) as EventSink,
      });
      ctx.provide(Cap.behavior, { respond: async () => ({ text: '' }) } as never);
    },
  );
  return { llm, engine, router };
}
