import type {
  Behavior,
  Clock,
  MediaDuplex,
  SessionInput,
  SpeechToText,
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
  voice?: string;
}
export interface LiveKitOptions {
  minInterruptionWords?: number;
  closeDeadlineMs?: number;
  markTimeoutMs?: number;
}
