import {
  Cap,
  MULAW_8K,
  SESSION_INPUT_JSON_SCHEMA,
  outcomeFor,
  type Behavior,
  type EndReason,
  type EngineEvent,
  type EngineOutcome,
  type MediaDuplex,
  type SessionInput,
  type SpeechReceipt,
  type VoiceSessionEngine as EngineV2,
} from '@winsendotai/ovo-contracts';
import { legacyFromDuplex, sttAsLegacy } from '../../plugin-kit/src/speech-shims.ts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import type { SpeechToText } from '@winsendotai/ovo-contracts';
import { BoundedSpeechScheduler } from './scheduler.ts';
import { VoiceSessionEngine as LegacyEngine } from './session-engine.ts';
import { STREAMING_VOICE_PLUGIN_IDS } from './production-plugins.ts';
import { VOICE_PLUGIN_IDS, VOICE_SERVICE_KEYS } from './types.ts';

/** The old engine remains the wave-1 audio loop; this adapter exposes its v2 host contract. */
export class NativeEngineV2Adapter implements EngineV2 {
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly unlistenSpeech: () => void;
  private readonly unlistenClose: () => void;
  private readonly resolveEnded: (outcome: EngineOutcome) => void;
  readonly ended: Promise<EngineOutcome>;
  private stopping?: Promise<EngineOutcome>;
  private finished = false;

  constructor(
    private readonly legacy: LegacyEngine,
    private readonly scheduler: BoundedSpeechScheduler,
    private readonly media: MediaDuplex,
  ) {
    let resolve!: (outcome: EngineOutcome) => void;
    this.ended = new Promise<EngineOutcome>((done) => (resolve = done));
    this.resolveEnded = resolve;
    this.unlistenSpeech = scheduler.subscribe((evidence) => {
      this.emit({ type: 'speech', evidence });
      if (evidence.phase === 'sent')
        this.emit({ type: 'timing', key: 'carrier_first_audio', atMs: evidence.at });
      if (evidence.phase === 'acknowledged')
        this.emit({ type: 'timing', key: 'playout_ack', atMs: evidence.at });
    });
    this.unlistenClose = media.onClose((reason) => {
      void this.dispose(reason).catch(() => undefined);
    });
  }

  get ingressStats() {
    return this.legacy.ingressStats;
  }

  start(): Promise<void> {
    return this.legacy.start();
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acceptedTranscript(revision: { revision: number; text: string }): void {
    const turnId = String(revision.revision);
    this.emit({ type: 'user.turn', phase: 'started', turnId, input: 'speech' });
    this.emit({
      type: 'user.transcript',
      turnId,
      segmentId: turnId,
      text: revision.text,
      stability: 'final',
    });
    this.emit({
      type: 'user.turn',
      phase: 'stopped',
      turnId,
      input: 'speech',
      text: revision.text,
    });
  }

  dispose(reason: EndReason, opts: { deadlineMs?: number } = {}): Promise<EngineOutcome> {
    if (this.stopping) return this.stopping;
    // Publish the in-flight promise before calling the transport: close callbacks can be synchronous.
    this.stopping = Promise.resolve().then(() => this.stop(reason, opts.deadlineMs ?? 2_000));
    return this.stopping;
  }

  private async stop(reason: EndReason, deadlineMs: number): Promise<EngineOutcome> {
    let timer!: NodeJS.Timeout;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('native engine disposal timed out')), deadlineMs);
      timer.unref?.();
    });
    let completedReason = reason;
    try {
      // Bound media closure and legacy disposal together. Neither can delay the returned outcome.
      await Promise.race([
        (async () => {
          await this.media.close(reason).catch(() => undefined);
          await this.legacy.dispose(reason, false);
        })(),
        timeout,
      ]);
    } catch {
      completedReason = 'error:native-engine-disposal';
    } finally {
      clearTimeout(timer);
    }
    const outcome = { reason: completedReason, outcome: outcomeFor(completedReason) };
    if (!this.finished) {
      this.finished = true;
      this.emit({ type: 'end', reason: completedReason });
      this.unlistenSpeech();
      this.unlistenClose();
      this.resolveEnded(outcome);
      this.listeners.clear();
    }
    return outcome;
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function withVariables(behavior: Behavior, session: SessionInput, media: MediaDuplex): Behavior {
  return new Proxy(behavior, {
    get(target, key, receiver) {
      if (key === 'respond')
        return (input: string) => target.respond(input, structuredClone(session.variables));
      if (key === 'respondStream' && target.respondStream)
        return (input: string) => target.respondStream!(input, structuredClone(session.variables));
      if (key === 'onPlayback' && target.onPlayback)
        return (receipt: SpeechReceipt) =>
          target.onPlayback!({
            ...receipt,
            ...(media.playbackEvidence === 'carrier-processed' &&
            session.acknowledgements.includes('weak-playback-evidence') &&
            receipt.evidence === 'confirmed'
              ? { evidenceSource: 'carrier-processed' as const }
              : {}),
          });
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createNativeVoiceEngineV2Plugin() {
  return definePlugin(
    {
      id: STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'ovo-native',
      provides: [`${Cap.engine}@2`],
      requires: [Cap.behavior, VOICE_SERVICE_KEYS.scheduler, Cap.media],
      optional: [Cap.stt],
      companions: {
        [Cap.speech]: VOICE_PLUGIN_IDS.scheduler,
        [VOICE_SERVICE_KEYS.scheduler]: VOICE_PLUGIN_IDS.scheduler,
        [VOICE_SERVICE_KEYS.output]: STREAMING_VOICE_PLUGIN_IDS.mediaOutput,
      },
      configSchema: {
        type: 'object',
        required: ['session', 'engine'],
        properties: {
          session: SESSION_INPUT_JSON_SCHEMA,
          engine: { type: 'object' },
        },
        additionalProperties: false,
      },
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
    async (ctx, config) => {
      const session = config.session as SessionInput;
      const behavior = ctx.get(Cap.behavior) as Behavior;
      const scheduler = ctx.get(VOICE_SERVICE_KEYS.scheduler) as BoundedSpeechScheduler;
      const media = ctx.get(Cap.media) as MediaDuplex;
      const stt = ctx.get(Cap.stt) as SpeechToText | undefined;
      let adapter!: NativeEngineV2Adapter;
      const old = new LegacyEngine(
        withVariables(behavior, session, media),
        scheduler,
        stt ? sttAsLegacy(stt, media.format) : undefined,
        legacyFromDuplex(media),
        {
          ...(config.engine as Record<string, unknown>),
          language: session.language,
          inputEnabled: session.inputEnabled,
          initialInput:
            session.mode === 'announcement' ? (session.initialInput ?? '') : session.initialInput,
          initialVariables: structuredClone(session.variables),
        },
        { onAcceptedTranscript: (revision) => adapter.acceptedTranscript(revision) },
      );
      adapter = new NativeEngineV2Adapter(old, scheduler, media);
      ctx.provide(Cap.engine, adapter);
      ctx.effect(() => () => adapter.dispose('drain'));
    },
  );
}
