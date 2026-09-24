import { bound, errorMessage } from './session-engine-guards.ts';
import type { Behavior, SpeechReceipt } from '@winsendotai/ovo-contracts';
import { isAbortError } from './async.ts';
import type { BoundedSpeechScheduler } from './scheduler.ts';
import type {
  StreamingStt,
  StreamingSttSession,
  TranscriptRevision,
  VoiceMediaTransport,
} from './provider-types.ts';
import { TranscriptTurnPolicy, type TurnPolicyConfig } from './turn-policy.ts';

export interface VoiceSessionEngineConfig extends TurnPolicyConfig {
  language?: string;
  inputEnabled?: boolean;
  initialInput?: string;
  initialVariables?: Record<string, unknown>;
  maxIngressFrames?: number;
  maxIngressBytes?: number;
  maxConcurrentTurns?: number;
  maxStreamingSegmentsAhead?: number;
}

export interface VoiceIngressStats {
  acceptedFrames: number;
  acceptedBytes: number;
  pendingFrames: number;
  pendingBytes: number;
  overflows: number;
}

export interface VoiceSessionEngineHooks {
  onAcceptedTranscript?: (revision: Readonly<TranscriptRevision>) => void;
  onInterrupt?: (reason: 'transcript' | 'dtmf') => void;
}

type VoiceBehavior = Behavior & {
  beginTurn?(epoch: number): void;
  onPlayback?(receipt: SpeechReceipt): void | Promise<void>;
  cancel?(): void;
  isComplete?(): boolean;
};

export class VoiceSessionEngine {
  private readonly controller = new AbortController();
  private readonly policy: TranscriptTurnPolicy;
  private readonly audioQueue: Uint8Array[] = [];
  private readonly turnTasks = new Set<Promise<void>>();
  private readonly maxIngressFrames: number;
  private readonly maxIngressBytes: number;
  private readonly maxConcurrentTurns: number;
  private readonly maxStreamingSegmentsAhead: number;
  private sttSession?: StreamingSttSession;
  private ingressDrain?: Promise<void>;
  private started = false;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private activeTurn?: number;
  private nextTurn = 0;
  private acceptedFrames = 0;
  private acceptedBytes = 0;
  private pendingFrames = 0;
  private pendingBytes = 0;
  private overflows = 0;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(
    private readonly behavior: VoiceBehavior,
    private readonly speech: BoundedSpeechScheduler,
    private readonly stt: StreamingStt | undefined,
    private readonly media: VoiceMediaTransport,
    private readonly config: VoiceSessionEngineConfig,
    private readonly hooks: VoiceSessionEngineHooks = {},
  ) {
    this.policy = new TranscriptTurnPolicy(config);
    this.maxIngressFrames = bound(config.maxIngressFrames ?? 100, 1, 1_000, 'maxIngressFrames');
    this.maxIngressBytes = bound(
      config.maxIngressBytes ?? 512 * 1024,
      1,
      8 * 1024 * 1024,
      'maxIngressBytes',
    );
    this.maxConcurrentTurns = bound(config.maxConcurrentTurns ?? 4, 1, 16, 'maxConcurrentTurns');
    this.maxStreamingSegmentsAhead = bound(
      config.maxStreamingSegmentsAhead ?? 2,
      1,
      8,
      'maxStreamingSegmentsAhead',
    );
  }

  get ingressStats(): VoiceIngressStats {
    return {
      acceptedFrames: this.acceptedFrames,
      acceptedBytes: this.acceptedBytes,
      pendingFrames: this.pendingFrames,
      pendingBytes: this.pendingBytes,
      overflows: this.overflows,
    };
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('voice session already started');
    this.started = true;
    const inputEnabled = this.config.inputEnabled ?? true;
    this.unsubscribers.push(
      this.media.onClose((reason) => this.disposeInBackground(`media closed: ${reason}`, false)),
    );
    if (inputEnabled) {
      if (!this.stt) throw new Error('Streaming STT is required when voice input is enabled');
      if (!this.config.language)
        throw new Error('Voice language is required when input is enabled');
      this.sttSession = await this.stt.start({
        sessionId: this.media.sessionId,
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        language: this.config.language,
        signal: this.controller.signal,
        onTranscript: (revision) => this.onTranscript(revision),
      });
      this.unsubscribers.push(
        this.media.onAudio((audio) => this.enqueueAudio(audio)),
        this.media.onDtmf((digit) => this.startTurn(digit, { inputEvent: 'dtmf' })),
      );
    }
    if (this.config.initialInput !== undefined)
      this.startTurn(this.config.initialInput, this.config.initialVariables);
  }

  private enqueueAudio(audio: Uint8Array): void {
    if (this.disposed || this.controller.signal.aborted || !this.sttSession) return;
    if (
      this.pendingFrames + 1 > this.maxIngressFrames ||
      this.pendingBytes + audio.byteLength > this.maxIngressBytes
    ) {
      this.overflows++;
      this.disposeInBackground('STT ingress capacity exceeded');
      return;
    }
    const owned = audio.slice();
    this.audioQueue.push(owned);
    this.acceptedFrames++;
    this.acceptedBytes += owned.byteLength;
    this.pendingFrames++;
    this.pendingBytes += owned.byteLength;
    this.ensureIngressDrain();
  }

  private ensureIngressDrain(): void {
    if (this.ingressDrain || !this.audioQueue.length || !this.sttSession) return;
    this.ingressDrain = this.drainIngress()
      .catch((error) => {
        if (!this.controller.signal.aborted && !isAbortError(error))
          this.disposeInBackground(`STT input failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.ingressDrain = undefined;
        if (this.audioQueue.length && !this.disposed) this.ensureIngressDrain();
      });
  }

  private async drainIngress(): Promise<void> {
    while (this.audioQueue.length && !this.controller.signal.aborted) {
      const audio = this.audioQueue.shift()!;
      try {
        await this.sttSession!.write(audio, this.controller.signal);
      } finally {
        this.pendingFrames--;
        this.pendingBytes -= audio.byteLength;
      }
    }
  }

  private onTranscript(revision: TranscriptRevision): void {
    if (this.disposed) return;
    const decision = this.policy.observe(revision);
    if (decision.interrupt) {
      this.hooks.onInterrupt?.('transcript');
      this.interruptActiveTurn('caller barge-in');
    }
    if (decision.accepted) {
      try {
        this.hooks.onAcceptedTranscript?.(Object.freeze(structuredClone(revision)));
      } catch {
        // Inspection and telemetry callbacks never become voice business authority.
      }
      this.startTurn(decision.accepted);
    }
  }

  private interruptActiveTurn(reason: string): void {
    if (this.activeTurn === undefined) return;
    this.activeTurn = undefined;
    this.cancelBehavior();
    void this.speech.interrupt().catch((error) => {
      if (!this.disposed)
        this.disposeInBackground(`${reason} flush failed: ${errorMessage(error)}`);
    });
  }

  private startTurn(input: string, variables?: Record<string, unknown>): void {
    if (this.disposed || this.controller.signal.aborted) return;
    if (this.activeTurn !== undefined) {
      if (variables?.inputEvent === 'dtmf') this.hooks.onInterrupt?.('dtmf');
      this.cancelBehavior();
    }
    if (this.turnTasks.size >= this.maxConcurrentTurns) {
      this.disposeInBackground('Turn cancellation backlog exceeded');
      return;
    }
    const turn = ++this.nextTurn;
    this.activeTurn = turn;
    let task!: Promise<void>;
    task = this.runTurn(turn, input, variables)
      .catch((error) => {
        if (this.isCurrent(turn) && !isAbortError(error))
          this.disposeInBackground(`turn failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.turnTasks.delete(task);
        if (this.activeTurn === turn) this.activeTurn = undefined;
      });
    this.turnTasks.add(task);
  }

  private async runTurn(
    turn: number,
    input: string,
    variables?: Record<string, unknown>,
  ): Promise<void> {
    this.controller.signal.throwIfAborted();
    const epoch = await this.speech.beginEpoch();
    if (!this.isCurrent(turn)) return;
    this.behavior.beginTurn?.(epoch);
    if (this.behavior.respondStream) {
      await this.runStreamingResponse(turn, epoch, this.behavior.respondStream(input, variables));
      if (!this.isCurrent(turn)) return;
      if (this.behavior.isComplete?.()) await this.dispose('behavior_completed');
      return;
    }
    const text = await this.behavior.respond(input, variables);
    if (!this.isCurrent(turn)) return;
    if (!text.trim()) {
      if (this.behavior.isComplete?.()) await this.dispose('behavior_completed');
      return;
    }
    const receipt = await this.speech.speak(text, { epoch });
    await this.behavior.onPlayback?.(receipt);
    if (!this.isCurrent(turn)) return;
    if (this.behavior.isComplete?.()) await this.dispose('behavior_completed');
  }

  private async runStreamingResponse(
    turn: number,
    epoch: number,
    stream: AsyncIterable<string>,
  ): Promise<void> {
    const pending: Promise<SpeechReceipt>[] = [];
    const settleNext = async () => {
      const receipt = await pending.shift()!;
      await this.behavior.onPlayback?.(receipt);
    };
    try {
      for await (const text of stream) {
        if (!this.isCurrent(turn)) break;
        if (!text.trim()) continue;
        pending.push(this.speech.speak(text, { epoch }));
        if (pending.length >= this.maxStreamingSegmentsAhead) await settleNext();
      }
    } catch (error) {
      if (this.isCurrent(turn)) await this.speech.interrupt();
      throw error;
    } finally {
      while (pending.length) await settleNext();
    }
  }

  private isCurrent(turn: number): boolean {
    return !this.disposed && !this.controller.signal.aborted && this.activeTurn === turn;
  }

  private cancelBehavior(): void {
    try {
      this.behavior.cancel?.();
    } catch (error) {
      this.disposeInBackground(`behavior cancellation failed: ${errorMessage(error)}`);
    }
  }

  dispose(reason = 'voice session disposed', closeMedia = true): Promise<void> {
    return (this.disposePromise ??= this.performDispose(reason, closeMedia));
  }

  private disposeInBackground(reason: string, closeMedia = true): void {
    void this.dispose(reason, closeMedia).catch(() => undefined);
  }

  private async performDispose(reason: string, closeMedia: boolean): Promise<void> {
    this.disposed = true;
    this.activeTurn = undefined;
    this.cancelBehavior();
    this.controller.abort(new DOMException(reason, 'AbortError'));
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    const queued = this.audioQueue.splice(0);
    this.pendingFrames -= queued.length;
    this.pendingBytes -= queued.reduce((total, audio) => total + audio.byteLength, 0);
    try {
      await this.sttSession?.finish();
    } catch {}
    await this.sttSession?.close(reason).catch(() => undefined);
    await this.speech.dispose();
    if (closeMedia) await this.media.close(reason).catch(() => undefined);
  }
}
