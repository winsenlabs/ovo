import type { TranscriptDoubt, TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { CallerAudio } from './caller-audio.ts';
import { TurnController } from './controller.ts';
import type {
  ControllerInput,
  EndOfTurnModel,
  EndOfTurnRequest,
  ModelGateConfig,
  ModelGatedTurnController,
  ModelGateStats,
  SpeechStop,
} from './model-gate-config.ts';
import { emptyStats, join, joinStop, predict, safetyRead } from './model-reading.ts';

/**
 * The model gate (Wave 13, T1) around the rules detector: what it does, and why, is described with
 * its settings in model-gate-config.ts.
 */
export class ModelGate implements ModelGatedTurnController {
  readonly stats: ModelGateStats = emptyStats();
  private readonly listeners = new Set<(decision: TurnDecision) => void>();
  private readonly inner: TurnController;
  private readonly callerAudio: CallerAudio;
  /** Inner turn ids and the outer ids they were announced under. */
  private readonly ids = new Map<string, string>();
  private sequence = 0;
  /** The outer turn the gate has open: announced, not yet stopped. */
  private open?: {
    id: string;
    startedAt: number;
    /** The words of earlier inner turns it was held on. */
    text: string;
    segments: number;
    /** The doubt of each of the rules' stops in the turn, in order (undefined: trusted). */
    doubts: (TranscriptDoubt | undefined)[];
    /** A stop waiting on the model or on the hold. */
    pending?: SpeechStop;
    /** The stop the turn was last held on, while the caller goes on (a reset brings it back). */
    last?: SpeechStop;
    phase: 'open' | 'predicting' | 'held';
    holdUntil?: number;
  };
  private cancelTimer?: () => void;
  private cancelRecheck?: () => void;
  private token = 0;
  private inFlight = new Set<Promise<void>>();
  private agentText?: string;
  private answering = false;
  private disposed = false;

  constructor(
    rules: unknown,
    private readonly gate: ModelGateConfig,
    private readonly model: EndOfTurnModel,
    private readonly input: ControllerInput,
  ) {
    this.inner = new TurnController(rules, input);
    this.callerAudio = new CallerAudio(gate.audioMs);
    this.inner.on((decision) => this.onInner(decision));
  }

  observe(event: VoiceEvent): void {
    if (this.disposed) return;
    if (event.type === 'bot.started') this.answering = !!event.question;
    this.inner.observe(event);
  }

  on(fn: (decision: TurnDecision) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    this.release();
    this.inner.dispose();
    this.listeners.clear();
  }

  audio(pcm: Int16Array, rate: 8000 | 16000): void {
    if (!this.disposed) this.callerAudio.push(pcm, rate, this.input.clock.now());
  }

  agentSaid(text: string): void {
    this.agentText = text;
  }

  async settled(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  private emit(decision: TurnDecision): void {
    for (const fn of [...this.listeners]) fn(decision);
  }

  private onInner(decision: TurnDecision): void {
    switch (decision.type) {
      case 'turn.started': {
        const open = this.open;
        if (open && open.phase !== 'open') {
          // The caller went on while the model was reading, or in the hold: the same turn.
          this.ids.set(decision.turnId, open.id);
          this.release();
          if (open.pending) {
            open.last = open.pending;
            open.text = open.pending.input.text;
            open.segments = open.pending.input.segments;
            open.pending = undefined;
          }
          open.phase = 'open';
          this.stats.merged++;
          return;
        }
        const id = `turn-${++this.sequence}`;
        this.ids.set(decision.turnId, id);
        this.open = {
          id,
          startedAt: this.input.clock.now(),
          text: '',
          segments: 0,
          doubts: [],
          phase: 'open',
        };
        return this.emit({ ...decision, turnId: id });
      }
      case 'turn.partial': {
        const id = this.ids.get(decision.turnId) ?? decision.turnId;
        const prefix = this.open?.id === id ? this.open.text : '';
        return this.emit({ ...decision, turnId: id, text: join(prefix, decision.text) });
      }
      case 'turn.stopped': {
        const id = this.ids.get(decision.turnId) ?? decision.turnId;
        this.ids.delete(decision.turnId);
        if (decision.input.kind !== 'speech' || this.open?.id !== id) {
          const held = this.open?.id === id ? (this.open.pending ?? this.open.last) : undefined;
          if (this.open?.id === id) this.open = undefined;
          if (!held) return this.emit({ ...decision, turnId: id });
          // Keys pressed in a hold: the held words end first, as they were, then the digits.
          this.release();
          this.emit({ ...held, reason: 'hold' });
          const digits = `turn-${++this.sequence}`;
          this.emit({ type: 'turn.started', turnId: digits });
          return this.emit({ ...decision, turnId: digits });
        }
        this.open.doubts.push(decision.untrusted);
        return this.read(joinStop(decision as SpeechStop, id, this.open, this.input.language));
      }
      case 'turn.reset': {
        const id = this.ids.get(decision.turnId) ?? decision.turnId;
        this.ids.delete(decision.turnId);
        const open = this.open;
        if (open?.id === id && open.last) {
          // A backchannel or muted words while held: the held turn goes on waiting.
          open.pending = open.last;
          open.phase = 'held';
          this.holdFor(Math.max(0, (open.holdUntil ?? 0) - this.input.clock.now()));
          return;
        }
        if (open?.id === id) this.open = undefined;
        return this.emit({ ...decision, turnId: id });
      }
      default:
        return this.emit(decision);
    }
  }

  /** The rules ended the turn: end it now, or once the model has read it. */
  private read(stop: SpeechStop): void {
    const open = this.open!;
    open.pending = stop;
    this.stats.stops++;
    const text = stop.input.text;
    const language = this.input.language;
    // An override moves the model's threshold; it never makes the model read a language it lacks.
    const covered = this.model.threshold(language);
    if (covered === undefined) return this.unread('language');
    const threshold = this.gate.threshold ?? covered;
    const { bypass, brokenOff } = safetyRead(text, this.gate.safety, {
      language,
      answering: this.answering,
    });
    if (bypass) return this.unread(bypass);
    const audio = this.callerAudio.since(open.startedAt - this.gate.preRollMs);
    if (this.model.input === 'audio' && !audio) {
      this.stats.bypassed.noAudio++;
      return brokenOff ? this.hold(text) : this.finish();
    }
    open.phase = 'predicting';
    const token = ++this.token;
    this.cancelTimer?.();
    this.cancelTimer = this.input.clock.setTimeout(() => {
      if (token !== this.token) return;
      this.token++;
      this.stats.timeouts++;
      if (brokenOff) this.hold(text);
      else this.finish();
    }, this.gate.timeoutMs);
    const request: EndOfTurnRequest = {
      text,
      language,
      ...(audio ? { audio } : {}),
      ...(this.agentText ? { agentText: this.agentText } : {}),
    };
    const read = (probability: number) => {
      if (token !== this.token || this.disposed) return;
      this.stats.predictions.push(probability);
      this.release();
      if (probability >= threshold && !brokenOff) this.finish();
      else {
        this.hold(text);
        if (!brokenOff) this.recheck(threshold);
      }
    };
    predict(this.model, request, this.inFlight, read, () => {
      if (token !== this.token || this.disposed) return;
      this.stats.failures++;
      this.release();
      this.finish();
    });
  }

  /** Ends the turn as the rules did, without the model. */
  private unread(why: 'shortAnswer' | 'question' | 'language'): void {
    this.stats.bypassed[why]++;
    this.finish();
  }

  private hold(text: string): void {
    const open = this.open;
    if (!open) return;
    open.phase = 'held';
    open.holdUntil = this.input.clock.now() + this.gate.holdMs;
    this.stats.held.push(text);
    this.holdFor(this.gate.holdMs);
  }

  private holdFor(ms: number): void {
    this.cancelTimer?.();
    const token = ++this.token;
    this.cancelTimer = this.input.clock.setTimeout(() => {
      if (token === this.token) this.finish('hold');
    }, ms);
  }

  /** While a turn stays held, an audio model reads it again every recheckMs (see the config). */
  private recheck(threshold: number): void {
    if (!this.gate.recheckMs || this.model.input !== 'audio') return;
    const token = this.token;
    const held = () => token === this.token && this.open?.phase === 'held' && !this.disposed;
    this.cancelRecheck = this.input.clock.setTimeout(() => {
      const open = this.open;
      if (!held() || !open?.pending) return;
      const audio = this.callerAudio.since(open.startedAt - this.gate.preRollMs);
      const settle = (probability: number) => {
        if (!held()) return;
        this.stats.rechecks.push(probability);
        if (probability < threshold) return this.recheck(threshold);
        this.stats.released++;
        this.finish();
      };
      const request = { text: open.pending.input.text, language: this.input.language };
      // A failed reading changes nothing: the hold runs out as it would have.
      predict(
        this.model,
        { ...request, ...(audio ? { audio } : {}) },
        this.inFlight,
        settle,
        () => {},
      );
    }, this.gate.recheckMs);
  }

  /** Stops the timers and drops a prediction still in flight. */
  private release(): void {
    this.token++;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.cancelRecheck?.();
    this.cancelRecheck = undefined;
  }

  private finish(reason?: 'hold'): void {
    const open = this.open;
    this.release();
    this.open = undefined;
    if (!open?.pending) return;
    this.emit(reason ? { ...open.pending, reason } : open.pending);
  }
}
