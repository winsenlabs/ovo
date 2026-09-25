import type {
  Behavior,
  Clock,
  EngineCapabilities,
  MediaDuplex,
  SessionInput,
  Speech,
  SpeechToText,
  TextToSpeech,
  TranscriptObserver,
  TurnDetectorFactory,
  UsageSink,
  VadAnalyzerFactory,
  VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';

/**
 * What the host hands an engine for one session. It never includes `ovo.execution` or a tool
 * connector: engines reach tools only through the behavior (§2.6, §3.8).
 */
export interface EnginePorts {
  sessionId: string;
  media: MediaDuplex;
  stt: SpeechToText;
  tts: TextToSpeech;
  behavior: Behavior;
  session: SessionInput;
  clock: Clock;
  usage: UsageSink;
  turnDetector?: TurnDetectorFactory;
  vad?: VadAnalyzerFactory;
  transcripts?: TranscriptObserver;
  voice?: string;
}

/**
 * An engine under test plus its `ovo.speech` companion, which must speak through the engine's
 * own audio path (§2.2). The kit gives that Speech to Execution for progress messages.
 */
export interface EngineUnderTest {
  engine: VoiceSessionEngine;
  speech: Speech;
  /**
   * What the plugin declares in its manifest for `ovo.voice-session-engine@2`. The kit requires it
   * and checks it against what the engine actually did (#F18).
   */
  capabilities?: EngineCapabilities;
}

export type EngineFactory = (ports: EnginePorts) => EngineUnderTest | Promise<EngineUnderTest>;
