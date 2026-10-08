import {
  classifyConfirmation,
  type EndpointRule,
  type SttEvent,
  type UserTurnController,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { isProviderEnd } from './stop-provider.ts';
import { canInterrupt, confirmationPrompt, speechMuted } from './mute.ts';
import { vadStartsTurn } from './start-vad.ts';
import { TurnControllerSpeech } from './controller-speech.ts';

/**
 * A VAD-only turn (a thump, a cough, noise) with no words this long after its commit ceiling is
 * reset rather than left open for stopTimeoutMs. Forced finals land within ~650 ms of the commit.
 */
const NOISE_GRACE_MS = 1000;

export class TurnController extends TurnControllerSpeech implements UserTurnController {
  observe(event: VoiceEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'stt':
        this.onStt(event.event);
        break;
      case 'vad.start':
        this.vadSpeaking = true;
        this.voiceEndMs = undefined;
        this.heardSinceFinal = true;
        this.vadStopPending = false;
        this.vadStopReady = false;
        this.forceSent = false;
        this.committed = false;
        this.stopTimers.cancel();
        this.commitTimers.speechStarted();
        this.noise.vadStarted();
        // VAD speech may now be timing the words: a short answer waits for its stop instead.
        this.commitTimers.reread();
        this.evidence.vadStarted();
        this.cutoff.resume();
        this.idle.cancel();
        if (vadStartsTurn(!!this.bot, speechMuted(this.view(), this.rules), this.config)) {
          this.start();
          if (
            this.bot &&
            canInterrupt(this.view(), this.rules) &&
            this.interruptedEpoch !== this.bot.epoch &&
            // N8: a sound alone never cuts the opening.
            this.opening.waitMs() === 0
          ) {
            this.interruptedEpoch = this.bot.epoch;
            this.emit({ type: 'interrupt', reason: 'vad' });
          }
        }
        // Words heard before the VAD caught up now have the caller's voice behind them.
        if (this.aggregate.view) this.maybeInterrupt();
        break;
      case 'vad.stop':
        this.vadSpeaking = false;
        this.voiceEndMs = event.atMs;
        this.noise.vadStopped();
        this.evidence.vadStopped();
        if (speechMuted(this.view(), this.rules)) break;
        if (this.strategy === 'vad-timeout') {
          this.vadStopPending = true;
          this.vadStopReady = false;
          if (!this.finalSeen) {
            this.forceSent = true;
            this.emit({ type: 'force-endpoint' });
          }
          this.stopTimers.start(
            this.config.userSpeechTimeoutMs,
            Math.max(
              0,
              (this.config.sttP99Ms ?? this.input.stt?.ttfsP99Ms ?? 1000) -
                (this.input.clock.now() - event.atMs),
            ),
            this.finalSeen,
          );
          this.safety();
        } else if (this.strategy === 'commit') {
          this.vadStopPending = true;
          this.vadStopReady = false;
          this.commitTimers.speechStopped(this.aggregate.view);
          this.safety();
        } else if (this.deferredStop) this.tryStop();
        break;
      case 'dtmf':
        if (this.tools && this.rules.includes('during-tools') && !this.config.allowDtmfWhileMuted)
          break;
        this.idle.cancel();
        // A key press is no speech: a turn the VAD opened on its tone, with no words, is dropped.
        if (this.turnId && !this.aggregate.view) this.reset('backchannel');
        this.dtmf.digit(event.digit);
        break;
      case 'bot.started':
        this.idle.cancel();
        if (!this.firstSpeechComplete) this.opening.botStarted(event.atMs);
        this.answering = !!event.question;
        this.bot = {
          epoch: event.epoch,
          kind: event.kind,
          question: event.question,
          filler: event.filler,
        };
        if (speechMuted(this.view(), this.rules)) this.reset('muted');
        break;
      case 'bot.stopped':
        if (this.bot && this.bot.epoch !== event.epoch) break;
        const wasPrompt = confirmationPrompt(this.view(), this.rules);
        this.bot = undefined;
        this.firstSpeechComplete = true;
        this.opening.end();
        if (this.answersQuestion && this.repliedEarly()) this.reset('backchannel');
        if (wasPrompt && this.turnId) {
          if (!this.aggregate.hasText) {
            this.awaitingConfirmationFinal = true;
            if (!this.speaking()) this.safety();
          } else if (classifyConfirmation(this.aggregate.text) === 'unclear') this.reset('muted');
          else if (this.holdsOpen()) this.deferredStop = true;
          else this.stopAfterAgent();
        } else if (this.deferredStop && !this.holdsOpen()) this.stopAfterAgent();
        if (!this.turnId && !this.tools && !this.speaking()) this.idle.arm();
        break;
      case 'tool.started':
        this.tools++;
        this.idle.cancel();
        if (this.turnId && this.rules.includes('during-tools')) this.reset('muted');
        break;
      case 'tool.settled':
        this.tools = Math.max(0, this.tools - 1);
        break;
      case 'confirmation.pending':
        this.confirmationPending = true;
        break;
      case 'confirmation.resolved':
        this.confirmationPending = false;
        break;
    }
  }

  private onStt(event: SttEvent): void {
    if (event.type === 'speech-start') {
      // A declared speech-end contract makes speech-start a latching signal. Without capabilities,
      // the provider may use end-of-turn as its only release signal (the conformance driver does).
      this.providerSpeaking = !!this.input.stt?.turnSignals.includes('speech-end');
      this.providerEndPending = false;
      this.idle.cancel();
      if (!this.vadStopPending) this.stopTimers.cancel();
      return;
    }
    if (event.type === 'speech-end') {
      this.providerSpeaking = false;
      if (this.providerEndPending || this.vadStopReady || this.deferredStop) this.tryStop();
      else this.safety();
      return;
    }
    if (event.type === 'transcript') {
      this.onTranscript(event);
      return;
    }
    if (isProviderEnd(event)) {
      if (event.type === 'end-of-turn' && event.eager) return;
      this.providerEndPending = true;
      if (this.strategy === 'provider' || !this.vadSpeaking) this.tryStop();
    }
  }

  /** Local silence or a stalled interim: force the endpoint, or end the turn on a final in hand. */
  protected commitDue(rule: EndpointRule): void {
    this.endRule = rule;
    // A caller who went on after the final must be committed again, even before their words show.
    if (this.finalCovers()) return this.commitReady();
    if (!this.forceSent) {
      this.forceSent = true;
      this.emit({ type: 'force-endpoint' });
    }
    this.committed = true;
    this.commitTimers.committed();
  }

  /** A final ends the turn once it answers the commit, or arrives after the VAD went quiet. */
  protected commitFinal(): void {
    if (!this.committed && !(this.vadStopPending && !this.vadSpeaking)) return;
    if (!this.committed) this.endRule = 'final';
    // The caller's onTranscript stops the turn once the flags are set.
    if (this.aggregate.view === this.aggregate.text) this.commitReady(false);
  }

  /** No final within userSpeechTimeoutMs of the commit: end on the interim text. */
  protected commitCeiling(): void {
    if (!this.turnId) return;
    if (!this.aggregate.view) {
      // Nothing transcribed: noise opened this turn. A late final still lands inside the grace.
      this.cancelSafety?.();
      this.cancelSafety = this.input.clock.setTimeout(() => {
        if (this.turnId && !this.aggregate.view && !this.speaking()) this.reset('backchannel');
      }, NOISE_GRACE_MS);
      return;
    }
    this.aggregate.closeOpenSegments();
    this.endRule = 'ceiling';
    this.commitReady();
  }

  /**
   * The VAD's speech brought no words for noiseMs (NoiseWatch): the room. A turn with words ends as
   * if the VAD had gone quiet; one with none yet waits for them, as before.
   */
  protected onNoise(): void {
    if (!this.turnId || this.speaking() || !this.aggregate.view) return;
    // The VAD speech since the final was the room: the final covers the caller's words.
    this.heardSinceFinal = false;
    const final = this.finalCovers();
    if (this.strategy === 'commit') {
      // Committed with its final still to come: that final, or the ceiling, ends the turn.
      if (!this.committed || final) this.commitDue('noise');
      return;
    }
    // A late final of words the turn ended on would open a phantom turn.
    if (!final) this.aggregate.closeOpenSegments();
    this.endRule = 'noise';
    this.tryStop();
  }

  /**
   * Call 6e1a4e3a turn 9: "Hardik?" said 2.4 s into a 12 s answer waited 9.4 s for it, as the
   * answer to the question it ended on. Said that long before the agent stopped, it came before
   * the question was heard, and only acknowledged what the agent was saying then.
   */
  private repliedEarly(): boolean {
    const windowMs = this.config.questionReplyMs;
    const at = this.lastWordsAt ?? this.input.clock.now();
    return windowMs > 0 && this.input.clock.now() - at > windowMs;
  }

  /** The agent stopped over words that waited for it (an answer to its question). */
  private stopAfterAgent(): void {
    this.endRule = 'agent';
    this.stop();
  }

  private commitReady(stop = true): void {
    this.vadStopPending = false;
    this.vadStopReady = true;
    this.committed = true;
    if (stop) this.tryStop();
  }

  protected onDigits(digits: string): void {
    if (!digits) {
      if (
        this.bot &&
        !confirmationPrompt(this.view(), this.rules) &&
        this.interruptedEpoch !== this.bot.epoch
      ) {
        this.interruptedEpoch = this.bot.epoch;
        this.emit({ type: 'interrupt', reason: 'dtmf' });
      }
      return;
    }
    const turnId = `turn-${++this.sequence}`;
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'turn.stopped', turnId, input: { kind: 'dtmf', digits } });
  }
}
