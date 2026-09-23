import {
  TurnConfigSchema,
  classifyConfirmation,
  countWords,
  defaultMuteRules,
  type Clock,
  type Mode,
  type MuteRule,
  type SpeechKindV2,
  type TurnConfig,
  type TurnDecision,
  type TurnDetectorFactory,
  type UserTurnController,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { DtmfCollector } from './dtmf-collector.ts';
import { IdleTimer } from './idle-timer.ts';
import { isAnswer, isBackchannel, muteFor } from './speech-gate.ts';

interface Turn {
  id: string;
  finals: Map<string, string>;
  interim: string;
}

/**
 * The in-kit reference turn detector: the §2.7 mute semantics, transcript barge-in with
 * min-words and backchannels, provider end-of-turn, DTMF collection and the idle policy. It is
 * deliberately small; E1's plugin is the production detector.
 */
export class ReferenceTurnController implements UserTurnController {
  private readonly listeners = new Set<(decision: TurnDecision) => void>();
  readonly rules: ReadonlySet<MuteRule>;
  bot?: { epoch: number; kind?: SpeechKindV2 };
  botSegments = 0;
  firstCompleted = false;
  private deferred?: { turn: Turn; text: string };
  private interruptedEpoch?: number;
  private confirmationPending = false;
  tools = 0;
  private turn?: Turn;
  private promptBuffer: string[] = [];
  private readonly dtmf: DtmfCollector;
  private readonly idle: IdleTimer;
  private turnCount = 0;
  private disposed = false;

  constructor(
    private readonly config: TurnConfig,
    private readonly clock: Clock,
    private readonly language: string,
    mode: Mode,
  ) {
    this.rules = new Set(config.mute.length ? config.mute : defaultMuteRules(mode));
    this.dtmf = new DtmfCollector(config.dtmf, clock, (digits) => this.digitsTurn(digits));
    this.idle = new IdleTimer(
      config.idle,
      clock,
      () => Boolean(this.turn || this.bot || this.tools > 0),
      (decision) => this.emit({ type: 'idle', ...decision }),
    );
  }

  on(fn: (decision: TurnDecision) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Test hook: inject a decision as if the detector made it. */
  emit(decision: TurnDecision): void {
    for (const fn of [...this.listeners]) fn(decision);
  }

  dispose(): void {
    this.disposed = true;
    this.dtmf.dispose();
    this.idle.stop();
    this.listeners.clear();
  }

  observe(event: VoiceEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'stt':
        return this.onStt(event.event);
      case 'dtmf':
        return this.onDigit(event.digit);
      case 'bot.started':
        this.idle.stop();
        this.bot = { epoch: event.epoch, kind: event.kind };
        this.botSegments += 1;
        if (event.kind === 'confirmation') this.promptBuffer = [];
        return;
      case 'bot.stopped':
        return this.onBotStopped(event.epoch);
      case 'tool.started':
        this.tools += 1;
        this.idle.stop();
        return;
      case 'tool.settled':
        this.tools = Math.max(0, this.tools - 1);
        return;
      case 'confirmation.pending':
        this.confirmationPending = true;
        return;
      case 'confirmation.resolved':
        this.confirmationPending = false;
        return;
      default:
        return;
    }
  }

  private muteForSpeech(): 'discard' | 'buffer' | undefined {
    return muteFor(this);
  }

  private isAnswer(text: string): boolean {
    return isAnswer(this.confirmationPending, text);
  }

  private isBackchannel(text: string): boolean {
    return isBackchannel(this.config.backchannels, this.confirmationPending, text);
  }

  private turnText(turn: Turn, withInterim = true): string {
    const parts = [...turn.finals.values()];
    if (withInterim && turn.interim) parts.push(turn.interim);
    return parts.filter(Boolean).join(' ').trim();
  }

  private onStt(event: Extract<VoiceEvent, { type: 'stt' }>['event']): void {
    if (event.type === 'transcript') {
      const { segment } = event;
      const mute = this.muteForSpeech();
      if (mute === 'buffer') {
        if (segment.stability === 'final' && segment.text.trim())
          this.promptBuffer.push(segment.text.trim());
        return;
      }
      if (mute === 'discard') {
        if (this.turn) this.reset('muted');
        return;
      }
      if (!segment.text.trim() && !this.turn) return;
      const turn = this.ensureTurn();
      if (segment.stability === 'final') {
        turn.finals.set(segment.segmentId, segment.text.trim());
        turn.interim = '';
      } else turn.interim = segment.text.trim();
      this.maybeInterrupt(turn);
      return;
    }
    if ((event.type === 'end-of-turn' && !event.eager) || event.type === 'utterance-end') {
      if (this.muteForSpeech() === 'buffer') return;
      this.finishSpeechTurn();
    }
  }

  private ensureTurn(): Turn {
    if (!this.turn) {
      this.idle.reset();
      this.turn = { id: `turn-${++this.turnCount}`, finals: new Map(), interim: '' };
      this.emit({ type: 'turn.started', turnId: this.turn.id });
    }
    return this.turn;
  }

  private maybeInterrupt(turn: Turn): void {
    if (!this.bot || this.interruptedEpoch === this.bot.epoch) return;
    const text = this.turnText(turn);
    if (this.isBackchannel(text) || this.isAnswer(text)) return;
    if (countWords(text, this.language) < this.config.minWordsWhileBotSpeaking) return;
    this.interruptedEpoch = this.bot.epoch;
    this.emit({ type: 'interrupt', reason: 'transcript' });
  }

  private finishSpeechTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    const text = this.turnText(turn, turn.finals.size === 0);
    if (!text) return;
    if (this.bot && this.interruptedEpoch !== this.bot.epoch) {
      if (this.isBackchannel(text)) return this.reset('backchannel');
      // An answer said over bot speech is held until the bot stops (§2.7).
      if (this.isAnswer(text)) {
        this.turn = undefined;
        this.deferred = { turn, text };
        return;
      }
    }
    this.turn = undefined;
    this.stopped(turn.id, text, turn.finals.size);
  }

  private stopped(turnId: string, text: string, segments: number): void {
    this.emit({
      type: 'turn.stopped',
      turnId,
      input: { kind: 'speech', text, segments: Math.max(1, segments) },
    });
  }

  private reset(reason: 'backchannel' | 'muted'): void {
    const turn = this.turn;
    this.turn = undefined;
    if (turn) this.emit({ type: 'turn.reset', turnId: turn.id, reason });
  }

  private onBotStopped(epoch: number): void {
    const bot = this.bot;
    if (bot && bot.epoch !== epoch) return;
    this.bot = undefined;
    if (bot) this.firstCompleted = true;
    const deferred = this.deferred;
    this.deferred = undefined;
    if (deferred) return this.stopped(deferred.turn.id, deferred.text, deferred.turn.finals.size);
    if (bot?.kind === 'confirmation' && this.promptBuffer.length) {
      const text = this.promptBuffer.join(' ');
      this.promptBuffer = [];
      const turn: Turn = { id: `turn-${++this.turnCount}`, finals: new Map(), interim: '' };
      this.emit({ type: 'turn.started', turnId: turn.id });
      if (classifyConfirmation(text) === 'unclear')
        this.emit({ type: 'turn.reset', turnId: turn.id, reason: 'muted' });
      else this.stopped(turn.id, text, 1);
      return;
    }
    this.idle.arm();
  }

  private onDigit(digit: string): void {
    const dtmf = this.config.dtmf;
    if (this.tools > 0 && this.rules.has('during-tools') && !this.config.allowDtmfWhileMuted)
      return;
    this.idle.stop();
    const bot = this.bot;
    if (
      !this.dtmf.collecting &&
      bot &&
      dtmf.interruptOnFirstDigit &&
      this.interruptedEpoch !== bot.epoch
    ) {
      this.interruptedEpoch = bot.epoch;
      this.emit({ type: 'interrupt', reason: 'dtmf' });
    }
    this.dtmf.push(digit);
  }

  private digitsTurn(digits: string): void {
    const turnId = `turn-${++this.turnCount}`;
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'turn.stopped', turnId, input: { kind: 'dtmf', digits } });
  }
}

/** A TurnDetectorFactory over the reference controller. `controllers` exposes every instance. */
export function createReferenceTurnDetector(
  config: Partial<TurnConfig> = {},
): TurnDetectorFactory & { readonly controllers: readonly ReferenceTurnController[] } {
  const controllers: ReferenceTurnController[] = [];
  return {
    controllers,
    create(input: { clock: Clock; language: string; mode: Mode; overrides?: Partial<TurnConfig> }) {
      const merged = TurnConfigSchema.parse({ ...config, ...input.overrides });
      const controller = new ReferenceTurnController(
        merged,
        input.clock,
        input.language,
        input.mode,
      );
      controllers.push(controller);
      return controller;
    },
  };
}
