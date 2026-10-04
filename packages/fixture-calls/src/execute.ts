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
import { callerPlayback, predictedAgentTexts } from './default-script.ts';
import { selectFixtureScripts } from './fixture-scripts.ts';
import { FixtureEffects } from './fixture-effects.ts';
import { fixtureExtensions, fixtureHostService } from './host-service.ts';
import type { FixtureCallInput, FixtureCallResult, FixtureRecordingWriter } from './types.ts';

function recordingMedia(
  media: MediaDuplex,
  clock: Clock,
  writer: FixtureRecordingWriter,
  effects: FixtureEffects,
): { media: MediaDuplex; off: () => void } {
  const write = (track: 'caller' | 'agent', bytes: Uint8Array, atMs: number) => {
    effects.run(() => writer.write(track, bytes.slice(), atMs));
  };
  const off = media.onAudio((bytes, atMs) => write('caller', bytes, atMs));
  return {
    off,
    media: {
      ...media,
      get bufferedBytes() {
        return media.bufferedBytes;
      },
      async sendAudio(bytes, signal) {
        write('agent', bytes, clock.now());
        await media.sendAudio(bytes, signal);
      },
    },
  };
}

/** Paid and carrier-control ports cannot cross into a fixture session, even from a live parent. */
export function fixtureParent(parent: ParentView | undefined): ParentView | undefined {
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
  const effects = new FixtureEffects();
  const net = deferredTtsNet(fixture.scripts, fixture.ttsTemplate, clock, fixture.sttReplay);
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
    // The fixture codec must receive the same canonical route shape as a real gateway stream.
    // This token is synthetic and is never submitted to the grant store.
    routeParams: { sid: callId, rt: 'fixture-route-token' },
  });
  if (!codec.decode(start).some((event) => event.type === 'start'))
    throw new Error('fixture_unavailable: selected carrier did not decode its start frame');
  const writer = input.release.config.recording ? await input.recording?.open(callId) : undefined;
  const recordingMediaHandle = writer
    ? recordingMedia(fake.duplex, clock, writer, effects)
    : undefined;
  const media = recordingMediaHandle?.media ?? fake.duplex;
  const host = fixtureHostService({
    media,
    clock,
    workspaceId: input.release.workspaceId,
    fixtureSecrets: input.fixtureSecrets,
    usage: (meter) => {
      const estimated = { ...meter, state: 'estimated' as const };
      usage.push(estimated);
      effects.run(() => input.telemetry?.onUsage?.(estimated));
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
  const caller = callerPlayback({
    clock,
    script,
    terminalAgentText: (input.agentTexts ?? predictedAgentTexts(input.release.config)).at(-1),
    reactiveConfirmation:
      input.release.config.mode === 'agent' &&
      (input.callerScript === undefined || input.callerScript === 'default'),
    say: (text, turnIndex) => {
      net.callerTurn(turnIndex);
      fake.caller.audio(speechBytes(format, Math.max(100, text.length * 20), 1));
    },
    dtmf: (digit) => fake.caller.dtmf(digit),
    hangup: () => {
      net.callerHangup();
      fake.caller.hangup('caller_hangup');
    },
  });
  const off = engine.subscribe((event) => {
    caller.onEvent(event);
    if (event.type === 'agent.transcript') {
      if (event.state === 'generated') net.generated(event.text, event.segmentId);
      else if (event.state === 'played') net.played(event.segmentId);
      else if (event.state === 'interrupted') net.interrupted(event.segmentId);
    }
    const row = { seq: events.length + 1, atMs: clock.now(), event };
    events.push(row);
    effects.run(() => input.telemetry?.onEvent?.(row));
  });
  let outcome: EngineOutcome | undefined;
  let failed = false;
  let failure: unknown;
  try {
    await effects.wait(() => engine.start());
    caller.start();
    outcome = await effects.wait(() => engine.ended);
    await effects.drain();
    net.assertComplete();
    const recording = writer ? await effects.wait(() => writer.finish(outcome!)) : undefined;
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
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const cleanup = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    };
    await cleanup(() => caller.cancel());
    await cleanup(off);
    await cleanup(() => recordingMediaHandle?.off());
    if (!outcome) await cleanup(() => engine.dispose('error:fixture-call'));
    await cleanup(() => composition.dispose());
    await cleanup(() => effects.drain());
    if (failed) throw failure;
  }
}
