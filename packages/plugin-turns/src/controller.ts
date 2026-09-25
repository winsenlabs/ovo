import {
  classifyConfirmation,
  type UserTurnController,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { confirmationPrompt, speechMuted } from './mute.ts';
import { vadStartsTurn } from './start-vad.ts';
import { TurnControllerState } from './controller-state.ts';

export class TurnController extends TurnControllerState implements UserTurnController {
  observe(event: VoiceEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'stt':
        this.onStt(event.event);
        break;
      case 'vad.start':
        this.vadSpeaking = true;
        this.vadStopPending = false;
        this.vadStopReady = false;
        this.forceSent = false;
        this.stopTimers.cancel();
        this.idle.cancel();
        if (vadStartsTurn(!!this.bot, speechMuted(this.view(), this.rules), this.config)) {
          this.start();
          if (this.bot && this.interruptedEpoch !== this.bot.epoch) {
            this.interruptedEpoch = this.bot.epoch;
            this.emit({ type: 'interrupt', reason: 'vad' });
          }
        }
        break;
      case 'vad.stop':
        this.vadSpeaking = false;
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
        } else if (this.deferredStop) this.tryStop();
        break;
      case 'dtmf':
        if (this.tools && this.rules.includes('during-tools') && !this.config.allowDtmfWhileMuted)
          break;
        this.idle.cancel();
        this.dtmf.digit(event.digit);
        break;
      case 'bot.started':
        this.idle.cancel();
        this.bot = { epoch: event.epoch, kind: event.kind };
        break;
      case 'bot.stopped':
        if (this.bot && this.bot.epoch !== event.epoch) break;
        const wasPrompt = confirmationPrompt(this.view(), this.rules);
        this.bot = undefined;
        this.firstSpeechComplete = true;
        if (wasPrompt && this.turnId) {
          if (!this.aggregate.hasText) {
            this.awaitingConfirmationFinal = true;
            if (!this.speaking()) this.safety();
          } else if (classifyConfirmation(this.aggregate.text) === 'unclear') this.reset('muted');
          else if (this.speaking()) this.deferredStop = true;
          else this.stop();
        } else if (this.deferredStop && !this.speaking()) this.stop();
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
}
