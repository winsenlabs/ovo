import {
  outcomeFor,
  type Behavior,
  type Clock,
  type EndReason,
  type EngineEvent,
  type EngineOutcome,
  type MediaDuplex,
  type SessionInput,
  type SpeechToText,
  type TranscriptObserver,
  type TextFilter,
  type TurnDetectorFactory,
  type UsageSink,
  type VadAnalyzerFactory,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import { BoundedSpeechScheduler } from '../scheduler.ts';
import { realClock } from './clock.ts';
import { VoiceEventBus } from './events.ts';
import { VoiceIngress } from './ingress.ts';
import { ingressLimitsFor } from './ingress-backlog.ts';
import { TurnLatency } from './latency.ts';
import { SpeechEventProjector } from './speech-events.ts';
import { describeError, logVoiceEvent } from './log.ts';
import { createTurnController } from './turn-controller-host.ts';
import { TurnDriver } from './turn-driver.ts';
import { startWatchdog } from './watchdog.ts';

export { DEFAULT_KEEP_MS, DEFAULT_PRE_STT_BUFFER_MS } from './ingress-backlog.ts';

export interface NativeEnginePorts {
  behavior: Behavior;
  scheduler: BoundedSpeechScheduler;
  media: MediaDuplex;
  stt?: SpeechToText;
  vad?: VadAnalyzerFactory;
  turnDetector?: TurnDetectorFactory;
  session: SessionInput;
  clock?: Clock;
  usage?: UsageSink;
  transcripts?: TranscriptObserver;
  textFilters?: readonly TextFilter[];
  engine?: {
    prefetchSegments?: number;
    maxPrefetchBytes?: number;
    markTimeoutMs?: number;
    maxIngressFrames?: number;
    maxIngressBytes?: number;
    maxConcurrentTurns?: number;
    preSttBufferMs?: number;
  };
}

/** Native v2 engine. The scheduler is also the companion ovo.speech port. */
export class NativeVoiceSessionEngine implements VoiceSessionEngine {
  private readonly bus = new VoiceEventBus();
  private readonly clock: Clock;
  private readonly controller = new AbortController();
  private readonly unsubs: (() => void)[] = [];
  private readonly latency: TurnLatency;
  private readonly speechEvents: SpeechEventProjector;
  private readonly driver: TurnDriver;
  private readonly turnController;
  private readonly resolveEnded: (outcome: EngineOutcome) => void;
  readonly ended: Promise<EngineOutcome>;
  private ingress?: VoiceIngress;
  private stopping?: Promise<EngineOutcome>;
  private started = false;
  private cancelWatchdog?: () => void;

  constructor(private readonly ports: NativeEnginePorts) {
    this.clock = ports.clock ?? realClock;
    let resolve!: (outcome: EngineOutcome) => void;
    this.ended = new Promise((done) => (resolve = done));
    this.resolveEnded = resolve;
    this.turnController = createTurnController({
      factory: ports.turnDetector,
      clock: this.clock,
      stt: ports.stt,
      vad: Boolean(ports.vad),
      session: ports.session,
    });
    this.latency = new TurnLatency(this.clock, (event) => this.emit(event));
    this.driver = new TurnDriver(
      ports.behavior,
      ports.scheduler,
      ports.session,
      this.bus,
      this.latency,
      (reason) => void this.dispose(reason),
      ports.engine?.maxConcurrentTurns ?? 4,
      ports.media,
    );
    this.speechEvents = new SpeechEventProjector(
      this.bus,
      this.latency,
      (epoch) => this.driver.turnIdForEpoch(epoch),
      (event) => this.emit(event),
    );
    this.unsubs.push(
      this.bus.onEvent((event) => {
        if (event.type === 'vad.stop') this.latency.noteVadStop();
        if (event.type === 'stt' && event.event.type === 'transcript') {
          const segment = event.event.segment;
          if (segment.stability === 'final') this.latency.noteFinalStt();
          this.emit({
            type: 'user.transcript',
            turnId: segment.segmentId,
            segmentId: segment.segmentId,
            text: segment.text,
            stability: segment.stability,
          });
        }
        this.turnController.observe(event);
      }),
      this.turnController.on((decision) => {
        if (decision.type === 'force-endpoint')
          void this.ingress?.forceEndpoint().catch((error: unknown) => {
            this.log('stt_force_endpoint_failed', error);
            void this.dispose('error:stt');
          });
        this.driver.decide(decision);
      }),
      ports.scheduler.subscribe((evidence) => this.speechEvents.onSpeech(evidence)),
    );
    this.unsubs.push(
      ports.behavior.subscribe?.((event) =>
        this.bus.observe({ type: event.type, atMs: this.clock.now() }),
      ) ?? (() => undefined),
    );
  }

  get ingressStats() {
    return (
      this.ingress?.stats ?? {
        acceptedFrames: 0,
        acceptedBytes: 0,
        pendingFrames: 0,
        pendingBytes: 0,
        overflows: 0,
      }
    );
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    return this.bus.onEngine(listener);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('native voice engine already started');
    this.started = true;
    const { media, session, stt, vad } = this.ports;
    this.ports.scheduler.configurePipeline(this.ports.engine?.prefetchSegments ?? 2);
    this.ports.scheduler.configureSession(session);
    this.ports.scheduler.configureOutput({
      maxPrefetchBytes: this.ports.engine?.maxPrefetchBytes,
      markTimeoutMs: this.ports.engine?.markTimeoutMs,
    });
    this.ports.scheduler.configureTiming((phase, segment, elapsedMs) =>
      this.speechEvents.onTiming(phase, segment, elapsedMs),
    );
    this.ports.scheduler.configureFilters(this.ports.textFilters ?? [], session.language);
    this.unsubs.push(
      media.onClose((reason) => void this.dispose(reason)),
      media.onDtmf((digit) => this.bus.observe({ type: 'dtmf', digit, atMs: this.clock.now() })),
      media.onAnsweredBy?.((result) => this.emit({ type: 'voicemail', result })) ??
        (() => undefined),
    );
    this.cancelWatchdog = startWatchdog(this.clock, session.maxCallSeconds, () => {
      void this.dispose('max_duration');
    });
    if (session.inputEnabled) {
      if (!stt) throw new Error('Native voice input requires ovo.stt');
      this.ingress = new VoiceIngress(
        media,
        ingressLimitsFor(this.ports.engine ?? {}, media.format),
        this.controller.signal,
        (event) => this.bus.observe(event),
        (reason) => void this.dispose(reason),
        vad,
      );
      await this.ingress.connect(stt, session.language, this.ports.usage ?? (() => undefined));
    }
    if (session.initialInput !== undefined || session.mode === 'announcement')
      this.driver.initial(session.initialInput ?? '');
  }

  dispose(reason: EndReason, opts: { deadlineMs?: number } = {}): Promise<EngineOutcome> {
    if (this.stopping) return this.stopping;
    // Publish before closing media; its close callback may fire synchronously.
    this.stopping = Promise.resolve().then(() => this.stop(reason, opts.deadlineMs ?? 2_000));
    return this.stopping;
  }

  private async stop(reason: EndReason, deadlineMs: number): Promise<EngineOutcome> {
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('engine disposal timeout')), deadlineMs);
      timer.unref?.();
    });
    let endedReason = reason;
    const failed = (error?: unknown) => {
      this.log('engine_disposal_failed', error, { reason });
      endedReason = 'error:native-engine-disposal';
    };
    // Every acquired port gets its cleanup attempt even when another hook throws
    // synchronously. Invoke close first to preserve the carrier termination fence.
    const attempt = (cleanup: () => void | Promise<void>): Promise<void> => {
      try {
        return Promise.resolve(cleanup()).catch(failed);
      } catch (error) {
        failed(error);
        return Promise.resolve();
      }
    };
    const close = attempt(() => this.ports.media.close(reason));
    const watchdog = attempt(() => this.cancelWatchdog?.());
    const detector = attempt(() => this.turnController.dispose());
    const graceful = reason === 'behavior_completed';
    if (!graceful) this.controller.abort(new DOMException(reason, 'AbortError'));
    const ingress = attempt(() => this.ingress?.dispose(graceful));
    if (graceful) void ingress.then(() => this.controller.abort());
    const cleanup = [
      close,
      watchdog,
      detector,
      ingress,
      attempt(() => this.ports.scheduler.dispose()),
      attempt(() => this.driver.dispose()),
    ];
    const unsubscribe = () => Promise.all(this.unsubs.splice(0).map(attempt));
    try {
      // Keep evidence subscribed until scheduler disposal publishes each terminal
      // phase. Unsubscription still shares the overall deadline.
      await Promise.race([Promise.all(cleanup).then(unsubscribe), deadline]);
    } catch (error) {
      failed(error);
    } finally {
      clearTimeout(timer);
      this.controller.abort();
      void unsubscribe();
    }
    const outcome = { reason: endedReason, outcome: outcomeFor(endedReason) };
    try {
      this.emit({ type: 'end', reason: endedReason });
    } finally {
      this.resolveEnded(outcome);
      this.bus.clear();
    }
    return outcome;
  }

  private emit(event: EngineEvent): void {
    this.bus.emit(event);
    if (event.type === 'user.transcript' || event.type === 'agent.transcript') {
      try {
        this.ports.transcripts?.(event);
      } catch (error) {
        // Inspection is never voice business authority.
        this.log('transcript_observer_failed', error);
      }
    }
  }

  private log(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    const sessionId = this.ports.media.sessionId;
    logVoiceEvent('error', event, { sessionId, ...fields, error: describeError(error) });
  }
}
