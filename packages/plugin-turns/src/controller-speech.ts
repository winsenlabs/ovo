import {
  classifyConfirmation,
  offLanguage,
  pausesMidThought,
  seeksInformation,
  type SttEvent,
} from '@winsendotai/ovo-contracts';
import { TurnControllerState } from './controller-state.ts';
import { MutedWords } from './muted-words.ts';
import { canInterrupt, confirmationPrompt, speechMuted } from './mute.ts';
import { acknowledges, containsConfirmationPhrase, speechCanInterrupt } from './start-min-words.ts';
import { transcriptStartsTurn } from './start-transcript.ts';
import { endsCutOff, spokenText } from './transcript-text.ts';

/** The caller's words: when they start, barge in on and end a turn. */
export abstract class TurnControllerSpeech extends TurnControllerState {
  /** Wave 9: when the agent's reply (not a filler line) last started to play. */
  protected replyStartedAt?: number;
  /** Wave 12: words heard while muted, committed once that speech is over. */
  protected readonly muted = new MutedWords(
    this.aggregate,
    this.input.stt?.forceEndpoint ? () => this.emit({ type: 'force-endpoint' }) : undefined,
  );

  protected reset(reason: 'muted' | 'backchannel'): void {
    const text = this.aggregate.text || this.aggregate.view;
    if (this.turnId)
      this.emit({ type: 'turn.reset', turnId: this.turnId, reason, ...(text ? { text } : {}) });
    this.clear();
  }

  /**
   * Wave 9 (call 10d5ef30, D2): the open turn's words began as the agent's reply started to play
   * (`speechEvidence.replyStartMs`), before the caller could hear it: talk-over at its start, not
   * the room. Never the opening, which has its own guard (N8).
   */
  protected beganWithReply(): boolean {
    const windowMs = this.config.speechEvidence.replyStartMs;
    if (windowMs <= 0 || !this.firstSpeechComplete || this.replyStartedAt === undefined)
      return false;
    return this.startedAtMs - this.replyStartedAt <= windowMs;
  }

  protected tryStop(): void {
    if (speechMuted(this.view(), this.rules)) {
      this.reset('muted');
      return;
    }
    if (
      !this.turnId ||
      this.holdsOpen() ||
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
        if (this.bot.question) this.deferredStop = this.answersQuestion = true;
        else this.reset('backchannel');
        return;
      }
      // Words that could have barged in but that the VAD never heard are the room, not the caller.
      // Over a filler they count as in silence (LAT-6). Wave 9 (D2): a request begun as the reply
      // started is the caller's: it waits for the agent to stop, and is answered then. Words that
      // ask nothing stay the room's: an answer to café talk is worse than none.
      if (!this.bot.filler && !this.evidence.heardNow()) {
        if (this.beganWithReply() && seeksInformation(text) && !this.offLanguage(text))
          this.deferredStop = true;
        else this.reset('backchannel');
        return;
      }
      // N4: words outside the agent's languages (an STT that drifted, a background talker) are
      // not understood, so over the agent they are no turn either.
      if (this.offLanguage(text)) {
        this.reset('backchannel');
        return;
      }
    }
    // Words that trail off wait for the caller to go on ("…around the 1" + "st."); Wave 9: words
    // that stop mid-thought ("No, umm...", "…it should still be a") wait the longer pause. Wave 12
    // (call 8cb76efc turns 21 and 24): so do words the STT broke off ("No. Have there been any-",
    // "…uh, what happens-"): live they waited the 700 ms hold, the caller went on 0.8 s and 0.4 s
    // later, and in between the LLM wrote "Could you finish your question?" and "Sorry, could you
    // say that again?", which only the engine's 2 s hold kept from playing over them.
    const unfinished = this.read(text).ends === 'unfinished';
    const { cutoffHoldMs, pauseHoldMs } = this.config;
    const pause =
      unfinished &&
      cutoffHoldMs > 0 &&
      pauseHoldMs > 0 &&
      (pausesMidThought(text) || endsCutOff(text));
    const expired = () => {
      this.endRule = pause ? 'pause' : 'hold';
      this.tryStop();
    };
    const holdMs = pause ? pauseHoldMs : undefined;
    if (this.cutoff.holds(unfinished, expired, holdMs, text)) return;
    // Wave 12 (call 8cb76efc turn 20): "Please." while its reply is composed is no turn of its own.
    if (this.owed.answers(text, this.startedAtMs, () => this.offLanguage(text)))
      return this.reset('backchannel');
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
      ) ||
      // N4: a transcript outside the agent's languages never barges in (call b1fd8b51: a Russian
      // interim cut the greeting at 2.27 s).
      this.offLanguage(this.aggregate.view)
    )
      return;
    // N8: the opening waits out its protected window, then for confirmed words.
    const openingMs = this.opening.waitMs();
    if (openingMs === Infinity) return;
    if (openingMs > 0) return this.opening.recheck(openingMs, () => this.maybeInterrupt());
    const waitMs = this.evidence.bargeInWaitMs();
    if (waitMs === Infinity) return;
    if (waitMs > 0) return this.evidence.recheck(waitMs, () => this.maybeInterrupt());
    this.interruptedEpoch = this.bot.epoch;
    this.emit({ type: 'interrupt', reason: 'transcript' });
  }

  /**
   * Call 6e1a4e3a turn 9: "Hardik?" said 2.4 s into a 12 s answer waited 9.4 s for it, as the
   * answer to the question it ended on. Said that long before the agent stopped, it came before
   * the question was heard, and only acknowledged what the agent was saying then.
   */
  protected repliedEarly(): boolean {
    const windowMs = this.config.questionReplyMs;
    const at = this.lastWordsAt ?? this.input.clock.now();
    return windowMs > 0 && this.input.clock.now() - at > windowMs;
  }

  /** Muted speech ended with the VAD's stop: its words are over (`MutedWords`). */
  protected mutedStop(): boolean {
    if (!speechMuted(this.view(), this.rules)) return false;
    this.muted.over();
    return true;
  }

  private offLanguage(text: string): boolean {
    return Boolean(this.config.languages && offLanguage(text, this.config.languages));
  }

  protected safety(): void {
    this.cancelSafety?.();
    if (this.turnId && !this.holdsOpen() && this.config.stopTimeoutMs > 0)
      this.cancelSafety = this.input.clock.setTimeout(() => {
        if (!this.turnId || this.holdsOpen()) return;
        if (this.awaitingConfirmationFinal || (!this.aggregate.text && !this.aggregate.view)) {
          this.reset(this.awaitingConfirmationFinal ? 'muted' : 'backchannel');
          return;
        }
        this.endRule = 'safety';
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
      this.muted.heard(segment);
      this.start();
      this.reset('muted');
      return;
    }
    // A segment begun while muted that the caller carried on into a turn is final now: no longer
    // open, so the next agent stop commits nothing over the caller's next words.
    if (segment.stability === 'final') this.muted.heard(segment);
    const prompt = confirmationPrompt(view, this.rules);
    this.evidence.transcript();
    if (!prompt && !this.bot && !transcriptStartsTurn(segment.text, this.input.language)) return;
    if (!prompt && !this.bot && !this.turnId && !this.evidence.startsTurn()) return;
    this.start();
    const before = this.aggregate.view;
    this.aggregate.observe(segment);
    if (this.aggregate.view !== before) {
      // New words: the VAD run is the caller's (NoiseWatch).
      this.lastWordsAt = this.input.clock.now();
      this.noise.words();
    }
    this.opening.words(this.aggregate.view);
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
      this.heardSinceFinal = false;
      // Wave 9: the commit is answered; words the caller goes on with need a commit of their own.
      this.forceSent = false;
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
