import {
  defaultMuteRules,
  type Clock,
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
import { OpeningGuard } from './opening-guard.ts';
import { SpeechEvidence } from './speech-evidence.ts';
import { CommitTimers } from './stop-commit.ts';
import { SpeechStopTimers } from './stop-speech-timeout.ts';
import { stopStrategy, type StopStrategy } from './strategies.ts';
import { CutoffHold } from './transcript-text.ts';

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
  protected deferredStop = false;
  protected awaitingConfirmationFinal = false;
  protected disposed = false;
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
        this.tryStop();
      },
    );
    this.commitTimers = new CommitTimers(input.clock, this.config, {
      due: () => this.commitDue(),
      ceiling: () => this.commitCeiling(),
    });
    this.evidence = new SpeechEvidence(input.clock, this.config.speechEvidence, input.vad);
    this.cutoff = new CutoffHold(input.clock, this.config.cutoffHoldMs);
    this.opening = new OpeningGuard(input.clock, this.config.opening);
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
    this.evidence.cancel();
    this.opening.clear();
    this.cutoff.resume();
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
    // The caller has had a turn: whatever the agent says from here is no longer the opening.
    this.opening.end();
    const filler = this.announcer.nextFiller();
    this.emit({
      type: 'turn.stopped',
      turnId: id,
      input: { kind: 'speech', text, segments },
      ...(filler ? { filler } : {}),
    });
  }

  /** Ends the open turn once nothing holds it (controller-speech.ts). */
  protected abstract tryStop(): void;
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
