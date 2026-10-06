import {
  classifyConfirmation,
  defaultMuteRules,
  type Clock,
  type Mode,
  type MuteRule,
  type SpeechCapabilities,
  type SttEvent,
  type TurnConfig,
  type TurnDecision,
} from '@winsendotai/ovo-contracts';
import { TurnAggregator } from './aggregator.ts';
import { TurnAnnouncer } from './announce.ts';
import { DetectorConfigSchema, type DetectorConfig } from './config.ts';
import { DtmfCollector } from './dtmf.ts';
import { IdleTimer } from './idle.ts';
import { canInterrupt, confirmationPrompt, speechMuted, type MuteView } from './mute.ts';
import { containsConfirmationPhrase, speechCanInterrupt } from './start-min-words.ts';
import { transcriptStartsTurn } from './start-transcript.ts';
import { CommitTimers } from './stop-commit.ts';
import { SpeechStopTimers } from './stop-speech-timeout.ts';
import { stopStrategy, type StopStrategy } from './strategies.ts';

export interface ControllerInput {
  clock: Clock;
  stt?: SpeechCapabilities;
  vad: boolean;
  language: string;
  mode: Mode;
  overrides?: Partial<TurnConfig>;
}

export abstract class TurnControllerState {
  protected listeners = new Set<(decision: TurnDecision) => void>();
  protected readonly config: DetectorConfig;
  protected readonly rules: MuteRule[];
  protected readonly strategy: StopStrategy;
  protected readonly aggregate = new TurnAggregator();
  protected readonly dtmf: DtmfCollector;
  protected readonly idle: IdleTimer;
  protected readonly stopTimers: SpeechStopTimers;
  protected readonly commitTimers: CommitTimers;
  protected cancelSafety?: () => void;
  protected turnId?: string;
  protected sequence = 0;
  protected bot?: { epoch: number; kind?: MuteView['kind']; question?: boolean };
  protected interruptedEpoch?: number;
  protected firstSpeechComplete = false;
  protected tools = 0;
  protected confirmationPending = false;
  protected vadSpeaking = false;
  protected providerSpeaking = false;
  protected providerEndPending = false;
  protected vadStopPending = false;
  protected vadStopReady = false;
  protected forceSent = false;
  /** 'commit' decided the utterance is over; a VAD held open by noise no longer blocks the stop. */
  protected committed = false;
  protected finalSeen = false;
  protected deferredStop = false;
  protected awaitingConfirmationFinal = false;
  protected disposed = false;
  private readonly announcer: TurnAnnouncer;

  constructor(
    rowConfig: unknown,
    protected readonly input: ControllerInput,
  ) {
    this.config = DetectorConfigSchema.parse({
      ...DetectorConfigSchema.parse(rowConfig),
      ...input.overrides,
    });
    this.rules = this.config.mute.length ? this.config.mute : defaultMuteRules(input.mode);
    this.announcer = new TurnAnnouncer(this.config.filler, (decision) => this.emit(decision));
    this.strategy = stopStrategy(this.config, input.vad, input.stt);
    this.idle = new IdleTimer(input.clock, this.config.idle, (decision) => this.emit(decision));
    this.dtmf = new DtmfCollector(input.clock, this.config.dtmf, (digits) => this.onDigits(digits));
    this.stopTimers = new SpeechStopTimers(
      input.clock,
      () => {
        if (!this.forceSent && !this.finalSeen) {
          this.forceSent = true;
          this.emit({ type: 'force-endpoint' });
        }
      },
      () => {
        this.vadStopPending = false;
        this.vadStopReady = true;
        this.tryStop();
      },
    );
    this.commitTimers = new CommitTimers(input.clock, this.config, {
      due: () => this.commitDue(),
      ceiling: () => this.commitCeiling(),
    });
  }

  on(fn: (decision: TurnDecision) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  protected emit(decision: TurnDecision): void {
    for (const fn of [...this.listeners]) fn(decision);
  }
  protected view(): MuteView {
    return {
      botSpeaking: !!this.bot,
      kind: this.bot?.kind,
      toolRunning: this.tools > 0,
      firstSpeechComplete: this.firstSpeechComplete,
    };
  }
  protected speaking(): boolean {
    return this.vadSpeaking || this.providerSpeaking;
  }

  protected start(): void {
    if (this.turnId) return;
    this.idle.reset();
    this.turnId = `turn-${++this.sequence}`;
    this.emit({ type: 'turn.started', turnId: this.turnId });
  }

  protected reset(reason: 'muted' | 'backchannel'): void {
    if (this.turnId) this.emit({ type: 'turn.reset', turnId: this.turnId, reason });
    this.clear();
  }

  protected clear(): void {
    this.turnId = undefined;
    this.aggregate.clear();
    this.finalSeen = false;
    this.deferredStop = false;
    this.awaitingConfirmationFinal = false;
    this.providerEndPending = false;
    this.vadStopPending = false;
    this.vadStopReady = false;
    this.cancelSafety?.();
    this.cancelSafety = undefined;
    this.stopTimers.cancel();
    this.commitTimers.cancel();
    // The endpoint is forced once per utterance; a VAD held open across turns must not carry it.
    this.forceSent = this.committed = false;
    this.announcer.clear();
  }

  protected stop(): void {
    if (!this.turnId) return;
    const text = this.aggregate.text || this.aggregate.view;
    if (!text.trim()) return;
    const id = this.turnId;
    const segments = Math.max(1, this.aggregate.segments);
    this.clear();
    const filler = this.announcer.nextFiller();
    this.emit({
      type: 'turn.stopped',
      turnId: id,
      input: { kind: 'speech', text, segments },
      ...(filler ? { filler } : {}),
    });
  }

  protected tryStop(): void {
    if (speechMuted(this.view(), this.rules)) {
      this.reset('muted');
      return;
    }
    if (
      !this.turnId ||
      (this.committed ? this.providerSpeaking : this.speaking()) ||
      this.vadStopPending ||
      this.awaitingConfirmationFinal ||
      confirmationPrompt(this.view(), this.rules)
    )
      return;
    const text = this.aggregate.text || this.aggregate.view;
    if (!text) return;
    if (this.bot && this.interruptedEpoch !== this.bot.epoch) {
      if (this.confirmationPending && containsConfirmationPhrase(text)) {
        this.deferredStop = true;
        return;
      }
      if (!speechCanInterrupt(text, this.input.language, this.config, false)) {
        // AGT-9: a short reply over a question answers it once the agent stops; otherwise it only
        // acknowledges the agent and is no turn at all.
        if (this.bot.question) this.deferredStop = true;
        else this.reset('backchannel');
        return;
      }
    }
    this.stop();
  }

  protected safety(): void {
    this.cancelSafety?.();
    if (this.turnId && !this.speaking() && this.config.stopTimeoutMs > 0)
      this.cancelSafety = this.input.clock.setTimeout(() => {
        if (!this.turnId || this.speaking()) return;
        if (this.awaitingConfirmationFinal || (!this.aggregate.text && !this.aggregate.view)) {
          this.reset(this.awaitingConfirmationFinal ? 'muted' : 'backchannel');
          return;
        }
        this.tryStop();
      }, this.config.stopTimeoutMs);
  }

  protected onTranscript(event: Extract<SttEvent, { type: 'transcript' }>): void {
    const segment = event.segment;
    if (!segment.text.trim() || this.aggregate.isClosed(segment.segmentId)) return;
    this.idle.cancel();
    const view = this.view();
    if (speechMuted(view, this.rules)) {
      this.start();
      this.reset('muted');
      return;
    }
    const prompt = confirmationPrompt(view, this.rules);
    if (!prompt && !this.bot && !transcriptStartsTurn(segment.text, this.input.language)) return;
    this.start();
    this.aggregate.observe(segment);
    if (this.strategy === 'commit' && segment.stability === 'interim')
      this.commitTimers.interim(this.aggregate.view);
    if (
      this.bot &&
      !prompt &&
      canInterrupt(view, this.rules) &&
      this.interruptedEpoch !== this.bot.epoch &&
      speechCanInterrupt(
        this.aggregate.view,
        this.input.language,
        this.config,
        this.confirmationPending,
      )
    ) {
      this.interruptedEpoch = this.bot.epoch;
      this.emit({ type: 'interrupt', reason: 'transcript' });
    }
    // LAT-4: the utterance so far, once it is speech the agent will answer rather than ignore.
    if (!this.bot || this.interruptedEpoch === this.bot.epoch)
      this.announcer.partial(this.turnId!, this.aggregate.view, this.aggregate.text);
    if (segment.stability === 'final') {
      this.finalSeen = true;
      if (this.awaitingConfirmationFinal) {
        this.awaitingConfirmationFinal = false;
        if (classifyConfirmation(this.aggregate.text) === 'unclear') {
          this.reset('muted');
          return;
        }
        this.deferredStop = true;
      }
      this.stopTimers.final();
      if (this.strategy === 'commit') this.commitFinal();
    }
    this.safety();
    if (this.vadStopReady || this.deferredStop) this.tryStop();
  }

  protected abstract onDigits(digits: string): void;
  protected abstract commitDue(): void;
  protected abstract commitCeiling(): void;
  protected abstract commitFinal(): void;

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.dtmf.dispose();
    this.idle.cancel();
    this.listeners.clear();
  }
}
