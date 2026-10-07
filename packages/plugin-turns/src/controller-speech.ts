import { classifyConfirmation, type SttEvent } from '@winsendotai/ovo-contracts';
import { TurnControllerState } from './controller-state.ts';
import { canInterrupt, confirmationPrompt, speechMuted } from './mute.ts';
import { acknowledges, containsConfirmationPhrase, speechCanInterrupt } from './start-min-words.ts';
import { transcriptStartsTurn } from './start-transcript.ts';
import { spokenText } from './transcript-text.ts';

/** The caller's words: when they start, barge in on and end a turn. */
export abstract class TurnControllerSpeech extends TurnControllerState {
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
      if (acknowledges(text, this.input.language, this.config, this.bot.filler)) {
        // AGT-9: a short reply over a question answers it once the agent stops; otherwise it only
        // acknowledges the agent and is no turn at all.
        if (this.bot.question) this.deferredStop = true;
        else this.reset('backchannel');
        return;
      }
      // Words that could have barged in but that the VAD never heard are the room, not the caller.
      // Over a filler they count as in silence (LAT-6).
      if (!this.bot.filler && !this.evidence.heardNow()) {
        this.reset('backchannel');
        return;
      }
    }
    if (this.cutoff.holds(text, () => this.tryStop())) return;
    this.stop();
  }

  /**
   * A transcript over the agent barges in once it is real words rather than a backchannel, and
   * the caller's: with VAD speech behind it, re-checked as an open VAD run accumulates.
   */
  protected maybeInterrupt(): void {
    const view = this.view();
    if (
      !this.bot ||
      !this.turnId ||
      !canInterrupt(view, this.rules) ||
      this.interruptedEpoch === this.bot.epoch ||
      !speechCanInterrupt(
        this.aggregate.view,
        this.input.language,
        this.config,
        this.confirmationPending,
      )
    )
      return;
    const waitMs = this.evidence.bargeInWaitMs();
    if (waitMs === Infinity) return;
    if (waitMs > 0) return this.evidence.recheck(waitMs, () => this.maybeInterrupt());
    this.interruptedEpoch = this.bot.epoch;
    this.emit({ type: 'interrupt', reason: 'transcript' });
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
    const text = spokenText(event.segment.text);
    if (!text || this.aggregate.isClosed(event.segment.segmentId)) return;
    const segment = text === event.segment.text ? event.segment : { ...event.segment, text };
    this.idle.cancel();
    const view = this.view();
    if (speechMuted(view, this.rules)) {
      this.start();
      this.reset('muted');
      return;
    }
    const prompt = confirmationPrompt(view, this.rules);
    this.evidence.transcript();
    if (!prompt && !this.bot && !transcriptStartsTurn(segment.text, this.input.language)) return;
    if (!prompt && !this.bot && !this.turnId && !this.evidence.startsTurn()) return;
    this.start();
    this.aggregate.observe(segment);
    // New words: a turn held as broken off goes on, and waits again if it breaks off again.
    this.cutoff.resume();
    if (this.strategy === 'commit' && segment.stability === 'interim')
      this.commitTimers.interim(this.aggregate.view);
    this.maybeInterrupt();
    // LAT-4: the utterance so far, once it is speech the agent will answer rather than ignore.
    if (!this.bot || this.bot.filler || this.interruptedEpoch === this.bot.epoch)
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
}
