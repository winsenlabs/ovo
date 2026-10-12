import {
  continuesUtterance,
  countWords,
  defaultMuteRules,
  transcriptDoubt,
  type Clock,
  type EndpointRule,
  type Mode,
  type MuteRule,
  type SpeechCapabilities,
  type TurnConfig,
  type TurnDecision,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { TurnAggregator } from './aggregator.ts';
import { TurnAnnouncer } from './announce.ts';
import { DetectorConfigSchema, type DetectorConfig } from './config.ts';
import { DtmfCollector } from './dtmf.ts';
import { IdleTimer } from './idle.ts';
import type { MuteView } from './mute.ts';
import { NoiseWatch } from './noise-watch.ts';
import { OpeningGuard } from './opening-guard.ts';
import { SpeechEvidence } from './speech-evidence.ts';
import { CommitTimers, type WordsView } from './stop-commit.ts';
import { SpeechStopTimers } from './stop-speech-timeout.ts';
import { stopStrategy, type StopStrategy } from './strategies.ts';
import { CutoffHold } from './transcript-text.ts';
import {
  answersByItself,
  SHORT_ANSWER_WORDS,
  utteranceEnd,
  type UtteranceContext,
} from './utterance-end.ts';

/**
 * Wave 8b: how long after a turn that trailed off (`hold`) the caller's next words may still be
 * its end ("…to the 5th." then, 2 s later, "Of January.").
 */
const CARRY_ON_MS = 5_000;

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
  protected readonly evidence: SpeechEvidence;
  protected readonly cutoff: CutoffHold;
  protected readonly opening: OpeningGuard;
  protected readonly noise: NoiseWatch;
  protected cancelSafety?: () => void;
  protected turnId?: string;
  protected sequence = 0;
  protected bot?: Omit<Extract<VoiceEvent, { epoch: number }>, 'type' | 'atMs'>;
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
  /** VAD speech since the last final: its words may not have reached even an interim yet. */
  protected heardSinceFinal = false;
  protected deferredStop = false;
  protected awaitingConfirmationFinal = false;
  /** The rule that last moved the open turn towards its end (turn.stopped `reason`). */
  protected endRule?: EndpointRule;
  /** The agent's last speech asked the caller something, until the caller's next turn ends. */
  protected answering = false;
  /** When the open turn's words last changed. */
  protected lastWordsAt?: number;
  /** The open turn is a short reply over the agent's question, waiting for it to stop (AGT-9). */
  protected answersQuestion = false;
  protected disposed = false;
  /** Wave 8: when the open turn started, and when the VAD last heard its voice end. */
  protected startedAtMs = 0;
  protected voiceEndMs?: number;
  /** Wave 8b: the last turn's words, when they trailed off and the turn ended on a hold. */
  private trailedOff?: { text: string; atMs: number };
  protected readonly announcer: TurnAnnouncer;

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
        this.endRule = 'vad-timeout';
        this.tryStop();
      },
    );
    this.commitTimers = new CommitTimers(input.clock, this.config, {
      due: (rule) => this.commitDue(rule),
      ceiling: () => this.commitCeiling(),
      read: (view) => this.read(view),
    });
    this.evidence = new SpeechEvidence(input.clock, this.config.speechEvidence, input.vad);
    this.cutoff = new CutoffHold(input.clock, this.config.cutoffHoldMs);
    this.opening = new OpeningGuard(input.clock, this.config.opening);
    this.noise = new NoiseWatch(input.clock, this.config.noiseMs, () => this.onNoise());
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
  /** The caller is still talking: VAD speech that is not the room (NoiseWatch), or the STT's. */
  protected speaking(): boolean {
    return (this.vadSpeaking && !this.noise.noise) || this.providerSpeaking;
  }
  /** The final in hand covers everything the caller said: no newer words or speech. */
  protected finalCovers(): boolean {
    return this.finalSeen && !this.heardSinceFinal && this.aggregate.view === this.aggregate.text;
  }
  /** Speech still holds the open turn: once committed, a VAD held open by noise no longer does. */
  protected holdsOpen(): boolean {
    return this.committed ? this.providerSpeaking : this.speaking();
  }

  /**
   * How the words so far end (utterance-end.ts), and whether they are an answer that may end the
   * turn on its interim: one that answers by itself, with no VAD speech the caller may still be
   * in. A VAD the room holds open keeps the stall: the caller's next words may be on their way.
   */
  protected read(view: string): WordsView {
    const context: UtteranceContext = {
      language: this.input.language,
      backchannels: this.config.backchannels,
      answering: this.answering,
    };
    const ends = utteranceEnd(view, context);
    const answer =
      ends === 'complete' &&
      (answersByItself(view, context) ||
        this.endsTrailedOff(view) ||
        this.cutoff.carriesOn(view, this.input.language, SHORT_ANSWER_WORDS)) &&
      !this.speaking();
    return { view, ends, answer };
  }

  /**
   * Wave 8b (call e8a43f65, issue 7): a few complete words that carry on the last turn, which
   * trailed off, end like a short answer: "Of January." waited 1.8 s for the stall with no VAD
   * speech timing it.
   */
  private endsTrailedOff(view: string): boolean {
    const before = this.trailedOff;
    if (!before || this.input.clock.now() - before.atMs > CARRY_ON_MS) return false;
    if (countWords(view, this.input.language) > SHORT_ANSWER_WORDS) return false;
    return continuesUtterance(view, before.text);
  }

  protected start(): void {
    if (this.turnId) return;
    this.idle.reset();
    this.startedAtMs = this.input.clock.now();
    this.voiceEndMs = undefined;
    this.turnId = `turn-${++this.sequence}`;
    this.emit({ type: 'turn.started', turnId: this.turnId });
  }

  protected clear(): void {
    this.turnId = undefined;
    this.aggregate.clear();
    this.finalSeen = this.heardSinceFinal = false;
    this.deferredStop = false;
    this.awaitingConfirmationFinal = false;
    this.endRule = this.lastWordsAt = undefined;
    this.answersQuestion = false;
    this.providerEndPending = false;
    this.vadStopPending = false;
    this.vadStopReady = false;
    this.cancelSafety?.();
    this.cancelSafety = undefined;
    this.stopTimers.cancel();
    this.commitTimers.cancel();
    this.evidence.cancel();
    this.opening.clear();
    this.cutoff.clear();
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
    const reason = this.endRule ?? this.defaultRule();
    // Wave 8: words the STT doubted, or seconds of noise that gave a word or two, are not acted on.
    const untrusted = transcriptDoubt({
      text,
      language: this.input.language,
      confidence: this.aggregate.confidence,
      spokenMs: (this.voiceEndMs ?? this.input.clock.now()) - this.startedAtMs,
    });
    this.clear();
    this.trailedOff =
      reason === 'hold' || reason === 'pause' ? { text, atMs: this.input.clock.now() } : undefined;
    this.answering = false;
    // The caller has had a turn: whatever the agent says from here is no longer the opening.
    this.opening.end();
    const filler = this.announcer.nextFiller(text);
    this.emit({
      type: 'turn.stopped',
      turnId: id,
      input: { kind: 'speech', text, segments },
      ...(filler ? { filler } : {}),
      reason,
      ...(untrusted ? { untrusted } : {}),
    });
  }

  private defaultRule(): EndpointRule {
    return this.strategy === 'commit' ? 'final' : this.strategy;
  }

  /** Ends the open turn once nothing holds it (controller-speech.ts). */
  protected abstract tryStop(): void;
  protected abstract onDigits(digits: string): void;
  protected abstract commitDue(rule: EndpointRule): void;
  /** The VAD's speech turned out to be the room (NoiseWatch). */
  protected abstract onNoise(): void;
  protected abstract commitCeiling(): void;
  protected abstract commitFinal(): void;

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.noise.cancel();
    this.dtmf.dispose();
    this.idle.cancel();
    this.listeners.clear();
  }
}
