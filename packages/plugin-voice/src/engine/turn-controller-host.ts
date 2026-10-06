import type {
  Clock,
  SessionInput,
  SpeechToText,
  TurnDetectorFactory,
  UserTurnController,
} from '@winsendotai/ovo-contracts';
import { FallbackTurns } from './fallback-turns.ts';

export function createTurnController(input: {
  factory?: TurnDetectorFactory;
  clock: Clock;
  stt?: SpeechToText;
  vad: boolean;
  session: SessionInput;
}): UserTurnController {
  return (
    input.factory?.create({
      clock: input.clock,
      stt: input.stt?.capabilities,
      vad: input.vad,
      language: input.session.language,
      mode: input.session.mode,
    }) ?? new FallbackTurns(input.session.mode, input.session.language)
  );
}
