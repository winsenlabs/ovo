import { describeEngine, type EnginePorts } from '@winsendotai/ovo-conformance';
import { NATIVE_ENGINE_CAPABILITIES } from '../src/engine/plugin.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';

function factory(ports: EnginePorts) {
  const output = new NativeStreamingSpeechOutput(
    ports.tts,
    ports.media,
    ports.session,
    ports.usage,
    { markTimeoutMs: 600 },
  );
  const speech = new BoundedSpeechScheduler(output);
  const engine = new NativeVoiceSessionEngine({
    behavior: ports.behavior,
    scheduler: speech,
    media: ports.media,
    stt: ports.stt,
    vad: ports.vad,
    turnDetector: ports.turnDetector,
    session: ports.session,
    clock: ports.clock,
    usage: ports.usage,
    transcripts: ports.transcripts,
  });
  return { engine, speech, capabilities: NATIVE_ENGINE_CAPABILITIES };
}

describeEngine('OVO native engine with selected turn detector', factory);
describeEngine('OVO native engine with fallback turns', factory, { turnDetector: 'none' });
