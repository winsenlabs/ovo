/** The v1 speech and media types moved to contracts (`speech/legacy.ts`); this shim keeps old imports working. */
export type {
  StreamingStt,
  StreamingSttSession,
  StreamingTts,
  TranscriptRevision,
  VoiceCodec,
  VoiceMediaTransport,
  VoiceProviderUsage,
} from '@winsendotai/ovo-contracts';
