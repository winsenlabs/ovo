// The production engine assembled for a replay: OVO's native session engine, turn driver, scheduler
// and agent behaviour, the chosen turn detector, VAD and STT, behind a fake carrier. Only the
// carrier, the speech output (timed, not sounded) and the LLM (recorded) are stand-ins.
import { AgentBehavior } from '@winsendotai/ovo-behaviors';
import { createFakeCarrier, type FakeCarrier } from '@winsendotai/ovo-conformance/drivers';
import {
  AgentConfig,
  type Clock,
  type Inference,
  type SessionInput,
  type SpeechToText,
  type TurnDetectorFactory,
  type UsageSink,
  type VadAnalyzerFactory,
} from '@winsendotai/ovo-contracts';
import { BoundedSpeechScheduler, NativeVoiceSessionEngine } from '@winsendotai/ovo-plugin-voice';
import type { AgentProfile } from '../corpus/profile.ts';
import type { TimedEngineEvent } from '../log/export.ts';
import { TimedOutput, type OutputTiming } from './output.ts';

export interface ReplayPorts {
  /** Epoch ms, like the engine's real clock. */
  clock: Clock;
  /** The clock's reading at call time 0: events are stamped in call time. */
  zero: number;
  profile: AgentProfile;
  stt: SpeechToText;
  vad: VadAnalyzerFactory;
  detector: TurnDetectorFactory;
  inference: Inference;
  output: OutputTiming;
  sessionId: string;
  /** The STT's metered usage (an audio replay prices it). */
  usage?: UsageSink;
}

export interface ReplayEngine {
  engine: NativeVoiceSessionEngine;
  carrier: FakeCarrier;
  /** Every engine event, stamped in call time. */
  events: TimedEngineEvent[];
}

const SESSION: SessionInput = {
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 1800,
  acknowledgements: [],
};

export function replayEngine(ports: ReplayPorts): ReplayEngine {
  const { clock } = ports;
  const carrier = createFakeCarrier({ clock, sessionId: ports.sessionId, playback: 'manual' });
  const behavior = new AgentBehavior(
    AgentConfig.parse(ports.profile.agent),
    ports.inference,
    // No tools run in a replay: the recorded model only says words or ends the call.
    { execute: async () => ({ state: 'succeeded' }) as never },
    {
      workspaceId: 'eval',
      sessionId: ports.sessionId,
      now: () => new Date(clock.now()),
    },
  );
  const scheduler = new BoundedSpeechScheduler(new TimedOutput(clock, ports.output), {}, () =>
    clock.now(),
  );
  const session = { ...SESSION, language: String(ports.profile.agent.language ?? 'en-IN') };
  const engine = new NativeVoiceSessionEngine({
    behavior,
    scheduler,
    media: carrier.duplex,
    stt: ports.stt,
    vad: ports.vad,
    turnDetector: ports.detector,
    session,
    clock,
    inference: ports.inference,
    ...(ports.usage ? { usage: ports.usage } : {}),
  });
  const events: TimedEngineEvent[] = [];
  engine.subscribe((event) => events.push({ atMs: clock.now() - ports.zero, event }));
  return { engine, carrier, events };
}

/** 20 ms of μ-law silence, the frame a replay without audio sends. */
export const SILENT_FRAME = new Uint8Array(160).fill(0xff);
