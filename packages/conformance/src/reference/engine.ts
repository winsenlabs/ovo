import {
  outcomeFor,
  type EndReason,
  type EngineEvent,
  type EngineOutcome,
  type Speech,
  type SttSession,
  type TurnDecision,
  type UserTurnController,
  type VoiceEvent,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import type { EnginePorts, EngineUnderTest } from '../kit/engine-ports.ts';
import { ReferencePlayback } from './engine-playback.ts';
import { createReferenceTurnDetector } from './turn-detector.ts';

async function* single(text: Promise<string>): AsyncIterable<string> {
  yield await text;
}

/**
 * The in-kit reference engine: every §2.6 rule in the simplest form that passes the engine kit.
 * One media writer, receipts before the next turn, pending marks dropped before clear, variables
 * on every turn, bounded idempotent dispose. It is a test fake, not a production engine.
 */
export class ReferenceEngine implements VoiceSessionEngine {
  readonly ended: Promise<EngineOutcome>;
  private resolveEnded!: (outcome: EngineOutcome) => void;
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly playback: ReferencePlayback;
  private readonly cleanup: (() => void)[] = [];
  private detector?: UserTurnController;
  private stt?: SttSession;
  private sttWrites: Promise<unknown> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private turnAbort?: AbortController;
  private disposing?: Promise<EngineOutcome>;
  private readonly stats = {
    acceptedFrames: 0,
    acceptedBytes: 0,
    pendingFrames: 0,
    pendingBytes: 0,
    overflows: 0,
  };

  constructor(private readonly ports: EnginePorts) {
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    this.playback = new ReferencePlayback(
      ports,
      (event) => this.emit(event),
      (event) => this.observe(event),
    );
  }

  get ingressStats() {
    return { ...this.stats };
  }

  /** The `ovo.speech` companion: execution progress goes through this engine's playback. */
  readonly speech: Speech = {
    speak: (text, options) =>
      this.playback.speak(text, options?.epoch ?? this.epoch, options?.kind ?? 'progress'),
    interrupt: () => this.playback.interrupt(),
  };

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
    if (event.type === 'user.transcript' || event.type === 'agent.transcript')
      this.ports.transcripts?.(event);
  }

  private observe(event: VoiceEvent): void {
    this.detector?.observe(event);
  }

  async start(): Promise<void> {
    const { media, session, behavior, clock } = this.ports;
    const factory = this.ports.turnDetector ?? createReferenceTurnDetector();
    this.detector = factory.create({
      clock,
      stt: this.ports.stt.capabilities,
      vad: false,
      language: session.language,
      mode: session.mode,
    });
    this.cleanup.push(
      this.detector.on((decision) => this.onDecision(decision)),
      media.onClose((reason) => void this.dispose(reason)),
      media.onPlayed((name) => this.playback.onPlayed(name)),
      media.onDtmf((digit) => this.observe({ type: 'dtmf', digit, atMs: clock.now() })),
    );
    const off = behavior.subscribe?.((event) =>
      this.observe({ type: event.type, atMs: clock.now() }),
    );
    if (off) this.cleanup.push(off);
    if (session.inputEnabled) {
      this.stt = await this.ports.stt.start({
        sessionId: this.ports.sessionId,
        format: media.format,
        language: session.language,
        signal: new AbortController().signal,
        onUsage: this.ports.usage,
        onEvent: (event) => {
          this.observe({ type: 'stt', event, atMs: clock.now() });
          if (event.type === 'transcript')
            this.emit({
              type: 'user.transcript',
              turnId: `epoch-${this.epoch}`,
              segmentId: event.segment.segmentId,
              text: event.segment.text,
              stability: event.segment.stability,
            });
        },
      });
      this.cleanup.push(media.onAudio((bytes) => this.ingest(bytes)));
    }
    if (session.initialInput !== undefined || !session.inputEnabled)
      this.enqueue(session.initialInput ?? '', {});
  }

  private ingest(bytes: Uint8Array): void {
    const stt = this.stt;
    if (!stt || this.disposing) return;
    this.stats.acceptedFrames += 1;
    this.stats.acceptedBytes += bytes.byteLength;
    this.sttWrites = this.sttWrites.then(() => stt.write(bytes)).catch(() => undefined);
  }

  private onDecision(decision: TurnDecision): void {
    if (this.disposing) return;
    if (decision.type === 'interrupt') {
      this.emit({ type: 'interrupt', reason: decision.reason });
      this.turnAbort?.abort();
      this.ports.behavior.cancel?.();
      void this.playback.interrupt();
    } else if (decision.type === 'turn.started')
      this.emit({ type: 'user.turn', phase: 'started', turnId: decision.turnId });
    else if (decision.type === 'turn.stopped') {
      const input = decision.input;
      const text = input.kind === 'speech' ? input.text : input.digits;
      this.emit({
        type: 'user.turn',
        phase: 'stopped',
        turnId: decision.turnId,
        input: input.kind,
        text,
      });
      this.enqueue(text, input.kind === 'dtmf' ? { inputEvent: 'dtmf', digits: input.digits } : {});
    } else if (decision.type === 'idle') {
      if (decision.final) void this.dispose('caller_idle');
      else if (decision.prompt)
        void this.playback.speak(decision.prompt, this.epoch, 'idle-prompt');
    }
  }

  private enqueue(input: string, extra: Record<string, unknown>): void {
    this.queue = this.queue.then(() => this.runTurn(input, extra)).catch(() => undefined);
  }

  private async runTurn(input: string, extra: Record<string, unknown>): Promise<void> {
    if (this.disposing) return;
    const { behavior, session } = this.ports;
    const epoch = ++this.epoch;
    const abort = new AbortController();
    this.turnAbort = abort;
    behavior.beginTurn?.(epoch);
    const variables = { ...session.variables, ...extra };
    try {
      const stream = behavior.respondStream
        ? behavior.respondStream(input, variables)
        : single(behavior.respond(input, variables));
      for await (const text of stream) {
        if (abort.signal.aborted || this.disposing) break;
        if (!text.trim()) continue;
        const kind = behavior.speechKind?.(text) ?? 'response';
        const receipt = await this.playback.speak(text, epoch, kind, () => abort.signal.aborted);
        if (receipt.state === 'interrupted') break;
      }
    } catch {
      // A cancelled or failed behavior turn ends quietly; the next turn starts fresh.
    } finally {
      if (this.turnAbort === abort) this.turnAbort = undefined;
    }
    if (behavior.isComplete?.()) void this.dispose('behavior_completed');
  }

  dispose(reason: EndReason, opts: { deadlineMs?: number } = {}): Promise<EngineOutcome> {
    // Assigned before shutdown runs: closing media re-enters dispose through onClose.
    this.disposing ??= Promise.resolve().then(() => this.shutdown(reason, opts.deadlineMs ?? 2000));
    return this.disposing;
  }

  private async shutdown(reason: EndReason, deadlineMs: number): Promise<EngineOutcome> {
    const outcome: EngineOutcome = { reason, outcome: outcomeFor(reason) };
    const work = (async () => {
      await this.ports.media.close(reason).catch(() => undefined);
      this.playback.close();
      this.turnAbort?.abort();
      this.ports.behavior.cancel?.();
      await this.stt?.cancel(reason).catch(() => undefined);
    })();
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, deadlineMs))]);
    for (const off of this.cleanup.splice(0)) off();
    this.detector?.dispose();
    this.emit({ type: 'end', reason });
    this.resolveEnded(outcome);
    return outcome;
  }
}

export function createReferenceEngine(ports: EnginePorts): EngineUnderTest {
  const engine = new ReferenceEngine(ports);
  return { engine, speech: engine.speech };
}
