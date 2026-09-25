import {
  AgentConfig,
  Cap,
  MULAW_8K,
  outcomeFor,
  type EngineEvent,
  type EngineOutcome,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import {
  fixtureCarrierCapabilities,
  fixtureCarrierIngress,
  fixtureInboundFrame,
  fixtureSttPlugin,
  fixtureTtsPlugin,
  fixtureTemplates,
} from '@winsendotai/ovo-conformance/drivers';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';

const engineId = 'fixture-test-engine';
const carrierId = 'fixture-test-carrier';
const reply = 'Fixture answer.';

function fixtureEngine(attemptEgress = false) {
  return definePlugin(
    {
      id: engineId,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture-test',
      provides: [`${Cap.engine}@2`],
      requires: [Cap.media, `${Cap.stt}@2`, `${Cap.tts}@2`, Cap.usage],
      optional: [Cap.costLedger, Cap.carrierControl],
      capabilities: {
        turnDetection: ['provider'],
        bargeIn: true,
        dtmf: true,
        confirmedPlayback: true,
        ownsProviders: false,
        formats: [MULAW_8K],
        consumesTurnDetector: false,
      },
      conformance: ['engine@1'],
      configSchema: { type: 'object' },
      runtime: { egressHosts: [], modelLicences: [] },
    },
    (ctx) => {
      const media = ctx.get(Cap.media);
      const stt = ctx.get(Cap.stt);
      const tts = ctx.get(Cap.tts);
      const usage = ctx.get(Cap.usage);
      if (ctx.maybe(Cap.costLedger) || ctx.all(Cap.carrierControl).size)
        throw new Error('fixture engine received a paid or carrier-control port');
      const listeners = new Set<(event: EngineEvent) => void>();
      let settle!: (outcome: EngineOutcome) => void;
      const ended = new Promise<EngineOutcome>((resolve) => {
        settle = resolve;
      });
      let session: Awaited<ReturnType<typeof stt.start>> | undefined;
      let settled = false;
      const emit = (event: EngineEvent) => {
        for (const fn of listeners) fn(event);
      };
      const finish = async (reason: EngineOutcome['reason']) => {
        if (settled) return ended;
        settled = true;
        await session?.finish();
        emit({ type: 'end', reason });
        settle({ reason, outcome: outcomeFor(reason) });
        return ended;
      };
      const engine: VoiceSessionEngine = {
        ended,
        ingressStats: {
          acceptedFrames: 0,
          acceptedBytes: 0,
          pendingFrames: 0,
          pendingBytes: 0,
          overflows: 0,
        },
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        async start() {
          if (attemptEgress)
            await globalThis.fetch('https://egress-forbidden.invalid').catch(() => undefined);
          session = await stt.start({
            sessionId: media.sessionId,
            format: media.format,
            language: 'en-US',
            signal: new AbortController().signal,
            onUsage: usage,
            onEvent(event) {
              if (event.type !== 'transcript') return;
              emit({
                type: 'user.transcript',
                turnId: 'turn-1',
                segmentId: event.segment.segmentId,
                text: event.segment.text,
                stability: event.segment.stability,
              });
              if (event.segment.stability !== 'final') return;
              void (async () => {
                emit({
                  type: 'user.turn',
                  phase: 'stopped',
                  turnId: 'turn-1',
                  input: 'speech',
                  text: event.segment.text,
                });
                emit({
                  type: 'agent.transcript',
                  segmentId: 'agent-1',
                  text: reply,
                  state: 'generated',
                });
                emit({
                  type: 'timing',
                  key: 'tts_ttfb',
                  turnId: 'turn-1',
                  atMs: Date.now(),
                  ms: 12,
                });
                emit({
                  type: 'speech',
                  evidence: {
                    sequence: 1,
                    segmentId: 'agent-1',
                    text: reply,
                    epoch: 1,
                    kind: 'response',
                    phase: 'generated',
                    at: Date.now(),
                    evidence: 'generated',
                  },
                });
                for await (const audio of tts.synthesize({
                  sessionId: media.sessionId,
                  text: reply,
                  format: media.format,
                  language: 'en-US',
                  signal: new AbortController().signal,
                  onUsage: usage,
                }))
                  await media.sendAudio(audio);
                await media.mark('agent-1');
                await finish('behavior_completed');
              })();
            },
          });
          media.onAudio((bytes) => {
            void session?.write(bytes);
          });
        },
        dispose: (reason) => finish(reason),
      };
      ctx.provide(Cap.engine, engine);
    },
  );
}

export function input(recording = false, attemptEgress = false) {
  const config = AgentConfig.parse({
    name: 'Fixture',
    mode: 'faq',
    language: 'en-US',
    faq: [{ id: 'one', question: 'hello fixture', answer: reply }],
    recording,
  });
  const carrier = definePlugin(
    {
      id: carrierId,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'carrier',
      provider: fixtureCarrierCapabilities().carrierId,
      provides: [Cap.carrierIngress],
      capabilities: fixtureCarrierCapabilities(),
      conformance: ['carrier@1'],
      meters: [
        {
          key: 'fixture.carrier.call_seconds',
          unit: 'call_seconds',
          label: 'Call',
          role: 'carrier',
        },
      ],
      runtime: { egressHosts: [], modelLicences: [] },
      configSchema: { type: 'object' },
    },
    (ctx) => {
      ctx.provide(Cap.carrierIngress, fixtureCarrierIngress());
    },
  );
  const registry = new PluginRegistry([
    fixtureEngine(attemptEgress),
    carrier,
    fixtureSttPlugin,
    fixtureTtsPlugin,
  ]);
  const selection = (pluginId: string, bindingId?: string) => ({
    pluginId,
    version: registry.get(pluginId)!.manifest.version,
    ...(bindingId ? { bindingId } : {}),
    config: {},
  });
  const release = {
    id: 'release-1',
    workspaceId: 'workspace-1',
    config,
    plugins: [],
    selections: {
      engine: selection(engineId),
      carrier: selection(carrierId, 'env'),
      stt: selection(fixtureSttPlugin.manifest.id, 'env'),
      tts: selection(fixtureTtsPlugin.manifest.id, 'env'),
    },
  };
  return {
    release,
    registry,
    fixtures: {
      [carrierId]: [
        {
          host: 'fixture.invalid',
          source: 'https://fixture.invalid/docs/media',
          retrieved: '2026-09-25',
          steps: [],
        },
      ],
    },
    fixtureTemplates,
    carrier: {
      pluginId: carrierId,
      ingress: fixtureCarrierIngress(),
      inboundFrame: fixtureInboundFrame,
    },
    callerScript: { turns: [{ atMs: 0, say: 'hello fixture' }] },
    agentTexts: [reply],
  };
}
