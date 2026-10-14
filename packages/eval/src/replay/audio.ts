// Audio replay (live STT, real time): the caller track streamed as the carrier sent it, in 20 ms
// μ-law frames at its own pace, through the real energy VAD, a chosen STT plugin (adapted to the
// carrier format as the session host adapts it) and the turn detector, with the engine and
// behaviour behind them. The LLM is the recorded responder unless a live one is passed. Open loop:
// the caller says what they said live, when they said it, whatever the agent does differently.
import { readFile } from 'node:fs/promises';
import type {
  Clock,
  Inference,
  SpeechToText,
  TurnDetectorFactory,
  UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createEnergyVad } from '@winsendotai/ovo-plugin-vad';
import { adaptSpeechToText } from '@winsendotai/ovo-session-host/speech-adapters/stt-format';
import type { CorpusCall } from '../corpus/load.ts';
import { traceFromPcm } from '../corpus/vad-trace.ts';
import { decodeWav, durationMs, mulawFrames } from '../corpus/wav.ts';
import { buildTimeline } from '../timeline.ts';
import { replayEngine } from './engine.ts';
import { outputTiming } from './output.ts';
import { liveReplies, recordedResponder, recordingInference } from './responder.ts';
import type { ReplayResult } from './transcript.ts';

export interface AudioReplayOptions {
  detector: TurnDetectorFactory;
  stt: SpeechToText;
  /** A live LLM; the recorded responder otherwise. */
  inference?: Inference;
  log?: (line: string) => void;
}

export interface AudioReplayResult extends ReplayResult {
  /** Seconds of caller audio streamed to the provider. */
  audioSeconds: number;
  usage: { unit: string; quantity: string; state: string }[];
}

const FRAME_MS = 20;
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

export async function replayAudio(
  call: CorpusCall,
  options: AudioReplayOptions,
): Promise<AudioReplayResult> {
  if (!call.events) throw new Error(`${call.name}: an audio replay needs the call's events`);
  if (!call.audioPath || call.audioOffsetMs === undefined)
    throw new Error(`${call.name}: an audio replay needs the caller track and its offset`);
  const live = buildTimeline(call.events.engine, call.events.llm);
  const pcm = decodeWav(new Uint8Array(await readFile(call.audioPath)));
  const frames = mulawFrames(pcm, FRAME_MS);
  const startMs = Math.max(0, (live.agent[0]?.generatedAtMs ?? 0) - 5);
  const endMs = Math.min(live.end?.atMs ?? live.durationMs, call.audioOffsetMs + durationMs(pcm));
  // Call time 0 on the real clock: the engine starts now, at the call's opening.
  const zero = Date.now() - startMs;
  const usage: UsageMeter[] = [];
  const responder = recordedResponder(
    liveReplies(live, call.profile),
    call.profile,
    sleep,
    () => Date.now() - zero,
  );
  const liveLlm = options.inference
    ? recordingInference(options.inference, () => Date.now() - zero)
    : undefined;
  // The requests the engine made, to whichever LLM answered them.
  const requests = liveLlm?.requests ?? responder.requests;
  const run = replayEngine({
    clock: realClock,
    zero,
    profile: call.profile,
    stt: adaptSpeechToText(options.stt),
    vad: createEnergyVad(call.profile.vad),
    detector: options.detector,
    inference: liveLlm ?? responder,
    output: outputTiming(call.profile, live),
    sessionId: `eval-audio-${call.name}`,
    usage: (meter) => usage.push(meter),
  });
  const started = run.engine.start();
  let sent = 0;
  for (const [index, frame] of frames.entries()) {
    const at = call.audioOffsetMs + (index + 1) * FRAME_MS;
    if (at > endMs || run.carrier.closed) break;
    // Frames from before the opening are delivered at once: the engine buffers them pre-STT.
    await sleep(zero + at - Date.now());
    run.carrier.caller.audio(frame);
    sent++;
    if (index % 1500 === 0)
      options.log?.(`${call.name}: ${Math.round(at / 1000)} s of ${Math.round(endMs / 1000)} s`);
  }
  await sleep(1500);
  run.carrier.caller.hangup('caller_hangup');
  await started.catch((error: unknown) =>
    options.log?.(`${call.name}: engine start failed: ${String(error)}`),
  );
  await run.engine.ended;
  const timeline = buildTimeline(
    run.events,
    requests.map((request, n) => ({ atMs: request.atMs, id: `replay-${n + 1}` })),
  );
  return {
    timeline,
    vad: { ...traceFromPcm(pcm, call.audioOffsetMs, call.profile.vad) },
    notes: [
      `live STT${liveLlm ? ' and LLM' : ''}; ${Math.round((sent * FRAME_MS) / 1000)} s of caller audio streamed`,
    ],
    stats: {
      requests: requests.length,
      unmatchedRequests: requests.filter((r) => r.answeredBy === 'unmatched').length,
      modelledCommits: 0,
      commits: 0,
    },
    requests,
    audioSeconds: (sent * FRAME_MS) / 1000,
    usage: usage.map(({ unit, quantity, state }) => ({ unit, quantity: String(quantity), state })),
  };
}
