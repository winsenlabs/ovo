import {
  Cap,
  type Clock,
  type CompatIssue,
  type EngineOutcome,
  type MediaDuplex,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier, speechBytes } from '@winsendotai/ovo-conformance/drivers';
import { compose, type ParentView } from '@winsendotai/ovo-runtime';
import { selectSessionGraph } from '@winsendotai/ovo-session-host';
import { deferredTtsNet } from './deferred-tts-net.ts';
import { selectFixtureScripts } from './fixture-scripts.ts';
import { fixtureExtensions, fixtureHostService } from './host-service.ts';
import type { FixtureCallInput, FixtureCallResult, FixtureRecordingWriter } from './types.ts';

function recordingMedia(
  media: MediaDuplex,
  clock: Clock,
  writer: FixtureRecordingWriter,
  writes: Promise<void>[],
): MediaDuplex {
  const write = (track: 'caller' | 'agent', bytes: Uint8Array, atMs: number) => {
    writes.push(Promise.resolve(writer.write(track, bytes.slice(), atMs)));
  };
  media.onAudio((bytes, atMs) => write('caller', bytes, atMs));
  return {
    ...media,
    get bufferedBytes() {
      return media.bufferedBytes;
    },
    async sendAudio(bytes, signal) {
      write('agent', bytes, clock.now());
      await media.sendAudio(bytes, signal);
    },
  };
}

/** Paid and carrier-control ports cannot cross into a fixture session, even from a live parent. */
function fixtureParent(parent: ParentView | undefined): ParentView | undefined {
  if (!parent) return undefined;
  const blocked = new Set<string>([
    Cap.costLedger,
    Cap.carrierControl,
    Cap.legacyTelephony,
    Cap.operations,
    Cap.orchestrationStore,
  ]);
  const keys = new Set([...parent.keys].filter((key) => !blocked.has(key)));
  return {
    keys,
    get(key) {
      return blocked.has(key) ? undefined : parent.get(key);
    },
    all(key) {
      return blocked.has(key) ? new Map() : parent.all(key);
    },
  };
}

type Prepared = ReturnType<typeof selectFixtureScripts>;
export async function executeFixtureCall(
  input: FixtureCallInput & { release: NonNullable<FixtureCallInput['release']> },
  callId: string,
  clock: Clock,
  script: Exclude<FixtureCallInput['callerScript'], string | undefined>,
  fixture: Prepared,
  format: NonNullable<
    FixtureCallInput['carrier']['ingress']['capabilities']['media']['formats'][number]
  >,
  compatIssues: CompatIssue[],
): Promise<FixtureCallResult> {
  const events: FixtureCallResult['events'] = [];
  const usage: FixtureCallResult['usage'] = [];
  const callbacks: Promise<unknown>[] = [];
  const writes: Promise<void>[] = [];
  const net = deferredTtsNet(fixture.scripts, fixture.ttsTemplate, clock);
  const ingress = input.carrier.ingress;
  const codec = ingress.serializer.createSession({});
  const fake = createFakeCarrier({
    carrierId: ingress.carrierId,
    sessionId: callId,
    format,
    playbackEvidence: ingress.capabilities.media.playbackEvidence,
    clearFlushesMarkers: ingress.capabilities.media.clearFlushesMarkers,
    codec,
    inbound: input.carrier.inboundFrame,
    clock,
  });
  const start = input.carrier.inboundFrame({
    type: 'start',
    carrierCallId: callId,
    streamId: callId,
    format,
    routeParams: {},
  });
  if (!codec.decode(start).some((event) => event.type === 'start'))
    throw new Error('fixture_unavailable: selected carrier did not decode its start frame');
  const writer = input.release.config.recording ? await input.recording?.open(callId) : undefined;
  const media = writer ? recordingMedia(fake.duplex, clock, writer, writes) : fake.duplex;
  const host = fixtureHostService({
    media,
    clock,
    usage: (meter) => {
      const estimated = { ...meter, state: 'estimated' as const };
      usage.push(estimated);
      const pending = input.telemetry?.onUsage?.(estimated);
      if (pending) callbacks.push(Promise.resolve(pending));
    },
    transcript: () => undefined,
  });
  const parent = fixtureParent(input.parent);
  const graph = selectSessionGraph({
    release: { ...input.release, selections: fixture.selections },
    registry: fixture.registry,
    hostServices: [host],
    parent: parent?.keys ?? [],
    media,
    fixtures: true,
    installedExtensions: fixtureExtensions(input.release.config, input.installedExtensions),
    defaults: input.defaults,
  });
  const composition = await compose(graph.rows, graph.catalog, {
    scope: 'session',
    parent,
    workspaceId: input.release.workspaceId,
    net,
    fixtures: true,
    enforcement: 'enforce',
  });
  const engine = composition.get(Cap.engine) as VoiceSessionEngine | undefined;
  if (!engine || typeof engine.subscribe !== 'function') {
    await composition.dispose();
    throw new Error('Selected fixture engine does not expose the v2 session contract');
  }
  const off = engine.subscribe((event) => {
    if (event.type === 'agent.transcript' && event.state === 'generated') net.generated(event.text);
    const row = { seq: events.length + 1, atMs: clock.now(), event };
    events.push(row);
    const pending = input.telemetry?.onEvent?.(row);
    if (pending) callbacks.push(Promise.resolve(pending));
  });
  const cancels: (() => void)[] = [];
  let outcome: EngineOutcome | undefined;
  try {
    await engine.start();
    for (const turn of script.turns) {
      cancels.push(
        clock.setTimeout(() => {
          if (turn.say)
            fake.caller.audio(speechBytes(format, Math.max(100, turn.say.length * 20), 1));
          if (turn.dtmf) for (const digit of turn.dtmf) fake.caller.dtmf(digit);
        }, turn.atMs),
      );
    }
    const last = Math.max(0, ...script.turns.map((turn) => turn.atMs + (turn.silenceMs ?? 0)));
    cancels.push(clock.setTimeout(() => fake.caller.hangup('caller_hangup'), last + 5000));
    outcome = await engine.ended;
    await Promise.all([...callbacks, ...writes]);
    net.assertComplete();
    const recording = writer ? await writer.finish(outcome) : undefined;
    return {
      callId,
      kind: 'test',
      status: outcome.outcome === 'failed' ? 'failed' : 'completed',
      outcome,
      events,
      compatIssues,
      selections: graph.resolved,
      sttMode: fixture.sttMode,
      usage,
      carrierFrames: [...fake.wire],
      ...(recording === undefined ? {} : { recording }),
    };
  } finally {
    for (const cancel of cancels) cancel();
    off();
    if (!outcome) await engine.dispose('error:fixture-call');
    await composition.dispose();
  }
}
