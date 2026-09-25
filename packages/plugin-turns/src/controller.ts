import {
  TurnConfigSchema, classifyConfirmation, defaultMuteRules,
  type Clock, type Mode, type MuteRule, type SpeechCapabilities, type SttEvent,
  type TurnConfig, type TurnDecision, type UserTurnController, type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { TurnAggregator } from './aggregator.ts';
import { DtmfCollector } from './dtmf.ts';
import { IdleTimer } from './idle.ts';
import { canInterrupt, confirmationPrompt, speechMuted, type MuteView } from './mute.ts';
import { containsConfirmationPhrase, speechCanInterrupt } from './start-min-words.ts';
import { transcriptStartsTurn } from './start-transcript.ts';
import { vadStartsTurn } from './start-vad.ts';
import { isProviderEnd } from './stop-provider.ts';
import { SpeechStopTimers } from './stop-speech-timeout.ts';
import { stopStrategy } from './strategies.ts';

export interface ControllerInput { clock: Clock; stt?: SpeechCapabilities; vad: boolean; language: string; mode: Mode; overrides?: Partial<TurnConfig> }

export class TurnController implements UserTurnController {
  private listeners = new Set<(decision: TurnDecision) => void>();
  private readonly config: TurnConfig;
  private readonly rules: MuteRule[];
  private readonly strategy: 'provider' | 'vad-timeout';
  private readonly aggregate = new TurnAggregator();
  private readonly dtmf: DtmfCollector;
  private readonly idle: IdleTimer;
  private readonly stopTimers: SpeechStopTimers;
  private cancelSafety?: () => void;
  private turnId?: string;
  private sequence = 0;
  private bot?: { epoch: number; kind?: MuteView['kind'] };
  private interruptedEpoch?: number;
  private firstSpeechComplete = false;
  private tools = 0;
  private confirmationPending = false;
  private vadSpeaking = false;
  private providerSpeaking = false;
  private providerEndPending = false;
  private vadStopPending = false;
  private forceSent = false;
  private finalSeen = false;
  private deferredStop = false;
  private disposed = false;

  constructor(rowConfig: unknown, private readonly input: ControllerInput) {
    this.config = TurnConfigSchema.parse({ ...TurnConfigSchema.parse(rowConfig), ...input.overrides });
    this.rules = this.config.mute.length ? this.config.mute : defaultMuteRules(input.mode);
    this.strategy = stopStrategy(this.config, input.vad, input.stt);
    this.idle = new IdleTimer(input.clock, this.config.idle, (decision) => this.emit(decision));
    this.dtmf = new DtmfCollector(input.clock, this.config.dtmf, (digits) => this.onDigits(digits));
    this.stopTimers = new SpeechStopTimers(input.clock, () => {
      if (!this.forceSent && !this.finalSeen) { this.forceSent = true; this.emit({ type: 'force-endpoint' }); }
    }, () => {
      this.vadStopPending = false; this.tryStop();
    });
  }

  on(fn: (decision: TurnDecision) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(decision: TurnDecision): void { for (const fn of [...this.listeners]) fn(decision); }
  private view(): MuteView { return { botSpeaking: !!this.bot, kind: this.bot?.kind, toolRunning: this.tools > 0, firstSpeechComplete: this.firstSpeechComplete }; }
  private speaking(): boolean { return this.vadSpeaking || this.providerSpeaking; }

  private start(): void {
    if (this.turnId) return;
    this.idle.reset();
    this.turnId = `turn-${++this.sequence}`;
    this.emit({ type: 'turn.started', turnId: this.turnId });
  }

  private reset(reason: 'muted' | 'backchannel'): void {
    if (this.turnId) this.emit({ type: 'turn.reset', turnId: this.turnId, reason });
    this.clear();
  }

  private clear(): void {
    this.turnId = undefined; this.aggregate.clear(); this.finalSeen = false; this.deferredStop = false;
    this.providerEndPending = false; this.vadStopPending = false;
    this.cancelSafety?.(); this.cancelSafety = undefined; this.stopTimers.cancel();
  }

  private stop(): void {
    if (!this.turnId) return;
    const text = this.aggregate.text || this.aggregate.view;
    if (!text.trim()) return;
    const id = this.turnId; const segments = Math.max(1, this.aggregate.segments);
    this.clear();
    this.emit({ type: 'turn.stopped', turnId: id, input: { kind: 'speech', text, segments } });
  }

  private tryStop(): void {
    if (!this.turnId || this.speaking() || this.vadStopPending || confirmationPrompt(this.view(), this.rules)) return;
    const text = this.aggregate.text || this.aggregate.view;
    if (!text) return;
    if (this.bot && this.interruptedEpoch !== this.bot.epoch) {
      if (this.confirmationPending && containsConfirmationPhrase(text)) { this.deferredStop = true; return; }
      if (!speechCanInterrupt(text, this.input.language, this.config, false)) { this.reset('backchannel'); return; }
    }
    this.stop();
  }

  private safety(): void {
    this.cancelSafety?.();
    if (this.turnId && !this.speaking() && this.config.stopTimeoutMs > 0)
      this.cancelSafety = this.input.clock.setTimeout(() => this.tryStop(), this.config.stopTimeoutMs);
  }

  private onTranscript(event: Extract<SttEvent, { type: 'transcript' }>): void {
    const segment = event.segment;
    if (!segment.text.trim()) return;
    this.idle.cancel();
    const view = this.view();
    if (speechMuted(view, this.rules)) { this.start(); this.reset('muted'); return; }
    const prompt = confirmationPrompt(view, this.rules);
    if (!prompt && !this.bot && !transcriptStartsTurn(segment.text, this.input.language)) return;
    this.start(); this.aggregate.observe(segment);
    if (segment.stability === 'final') { this.finalSeen = true; this.stopTimers.final(); }
    if (this.bot && !prompt && canInterrupt(view, this.rules) && this.interruptedEpoch !== this.bot.epoch &&
      speechCanInterrupt(this.aggregate.view, this.input.language, this.config, this.confirmationPending)) {
      this.interruptedEpoch = this.bot.epoch;
      this.emit({ type: 'interrupt', reason: 'transcript' });
    }
    this.safety();
  }

  private onStt(event: SttEvent): void {
    if (event.type === 'speech-start') {
      // A declared speech-end contract makes speech-start a latching signal. Without capabilities,
      // the provider may use end-of-turn as its only release signal (the conformance driver does).
      this.providerSpeaking = !!this.input.stt?.turnSignals.includes('speech-end');
      this.providerEndPending = false; this.idle.cancel();
      if (!this.vadStopPending) this.stopTimers.cancel();
      return;
    }
    if (event.type === 'speech-end') {
      this.providerSpeaking = false;
      if (this.providerEndPending) this.tryStop(); else this.safety();
      return;
    }
    if (event.type === 'transcript') { this.onTranscript(event); return; }
    if (isProviderEnd(event)) {
      if (event.type === 'end-of-turn' && event.eager) return;
      this.providerEndPending = true;
      if (this.strategy === 'provider' || !this.vadSpeaking) this.tryStop();
    }
  }

  private onDigits(digits: string): void {
    if (!digits) {
      if (this.bot && !confirmationPrompt(this.view(), this.rules) && this.interruptedEpoch !== this.bot.epoch) {
        this.interruptedEpoch = this.bot.epoch; this.emit({ type: 'interrupt', reason: 'dtmf' });
      }
      return;
    }
    const turnId = `turn-${++this.sequence}`;
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'turn.stopped', turnId, input: { kind: 'dtmf', digits } });
  }

  observe(event: VoiceEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'stt': this.onStt(event.event); break;
      case 'vad.start':
        this.vadSpeaking = true; this.vadStopPending = false; this.forceSent = false;
        this.stopTimers.cancel(); this.idle.cancel();
        if (vadStartsTurn(!!this.bot, speechMuted(this.view(), this.rules), this.config)) {
          this.start();
          if (this.bot && this.interruptedEpoch !== this.bot.epoch) {
            this.interruptedEpoch = this.bot.epoch; this.emit({ type: 'interrupt', reason: 'vad' });
          }
        }
        break;
      case 'vad.stop':
        this.vadSpeaking = false;
        if (this.strategy === 'vad-timeout') {
          this.vadStopPending = true;
          if (!this.finalSeen) { this.forceSent = true; this.emit({ type: 'force-endpoint' }); }
          this.stopTimers.start(this.config.userSpeechTimeoutMs,
            Math.max(0, (this.config.sttP99Ms ?? this.input.stt?.ttfsP99Ms ?? 1000) - (this.input.clock.now() - event.atMs)), this.finalSeen);
        }
        break;
      case 'dtmf':
        if (this.tools && this.rules.includes('during-tools') && !this.config.allowDtmfWhileMuted) break;
        this.idle.cancel(); this.dtmf.digit(event.digit); break;
      case 'bot.started':
        this.idle.cancel(); this.bot = { epoch: event.epoch, kind: event.kind }; break;
      case 'bot.stopped':
        if (this.bot && this.bot.epoch !== event.epoch) break;
        const wasPrompt = confirmationPrompt(this.view(), this.rules);
        this.bot = undefined; this.firstSpeechComplete = true;
        if (wasPrompt && this.turnId) {
          if (classifyConfirmation(this.aggregate.text || this.aggregate.view) === 'unclear') this.reset('muted');
          else this.stop();
        } else if (this.deferredStop) this.stop();
        if (!this.turnId && !this.tools && !this.speaking()) this.idle.arm();
        break;
      case 'tool.started':
        this.tools++; this.idle.cancel();
        if (this.turnId && this.rules.includes('during-tools')) this.reset('muted');
        break;
      case 'tool.settled': this.tools = Math.max(0, this.tools - 1); break;
      case 'confirmation.pending': this.confirmationPending = true; break;
      case 'confirmation.resolved': this.confirmationPending = false; break;
    }
  }

  dispose(): void {
    this.disposed = true; this.clear(); this.dtmf.dispose(); this.idle.cancel(); this.listeners.clear();
  }
}
