import type {
  Behavior,
  Clock,
  MediaDuplex,
  SessionInput,
  SpeechToText,
  TextFilter,
  TextToSpeech,
  TranscriptObserver,
  UsageSink,
} from '@winsendotai/ovo-contracts';

export interface LiveKitPorts {
  media: MediaDuplex;
  stt?: SpeechToText;
  tts: TextToSpeech;
  behavior: Behavior;
  session: SessionInput;
  clock: Clock;
  usage: UsageSink;
  transcripts?: TranscriptObserver;
  /** The session's `ovo.text-filter`s (the Indian verbalisation), applied to every line. */
  textFilters?: readonly TextFilter[];
  voice?: string;
}
export interface LiveKitOptions {
  minInterruptionWords?: number;
  closeDeadlineMs?: number;
  markTimeoutMs?: number;
}
