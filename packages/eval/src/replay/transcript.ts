// Transcript replay (offline, deterministic, free): a recorded call's STT stream, with its real
// timings, through the real turn detector, engine and behaviour, on virtual time. The VAD hears
// what the call's VAD trace says (from the caller audio, or modelled from the turns when the call
// has none); with `vad: 'audio'` the real energy VAD analyses the caller track itself. The caller
// track, when there is one, is what the carrier delivers, so audio-based turn detectors hear it.
import { readFile } from 'node:fs/promises';
import type { TurnDetectorFactory, VadAnalyzerFactory } from '@winsendotai/ovo-contracts';
import { createEnergyVad } from '@winsendotai/ovo-plugin-vad';
import type { CorpusCall } from '../corpus/load.ts';
import { traceFromPcm, traceFromTurns, type VadTrace } from '../corpus/vad-trace.ts';
import { decodeWav, mulawFrames } from '../corpus/wav.ts';
import { buildTimeline, type CallTimeline, type Transcript } from '../timeline.ts';
import { replayEngine, SILENT_FRAME } from './engine.ts';
import { outputTiming } from './output.ts';
import { liveReplies, recordedResponder } from './responder.ts';
import { scribeModel } from './scribe-model.ts';
import { traceVad } from './vad-model.ts';
import { VirtualTime } from './virtual-time.ts';

export interface TranscriptReplayOptions {
  detector: TurnDetectorFactory;
  /** `trace` (default): the call's VAD trace; `audio`: the energy VAD over the caller track. */
  vad?: 'trace' | 'audio';
  /** Another STT's transcripts of the same call (an audio replay's), instead of the live ones. */
  transcripts?: readonly Transcript[];
  commitLatencyMs?: number;
  /** Ms after the call's last event to keep running (the engine ends on the caller's hang-up). */
  tailMs?: number;
}

export interface ReplayResult {
  timeline: CallTimeline;
  vad: VadTrace;
  notes: string[];
  stats: { requests: number; unmatchedRequests: number; modelledCommits: number; commits: number };
  /** Each LLM request and the live turn whose reply answered it. */
  requests: { atMs: number; input: string; answeredBy: string }[];
}

const FRAME_MS = 20;

async function callerFrames(
  call: CorpusCall,
): Promise<{ frames?: Uint8Array[]; trace?: VadTrace }> {
  if (!call.audioPath || call.audioOffsetMs === undefined) return {};
  const pcm = decodeWav(new Uint8Array(await readFile(call.audioPath)));
  return {
    frames: mulawFrames(pcm, FRAME_MS),
    trace: call.vad ?? traceFromPcm(pcm, call.audioOffsetMs, call.profile.vad),
  };
}

export async function replayTranscript(
  call: CorpusCall,
  options: TranscriptReplayOptions,
): Promise<ReplayResult> {
  if (!call.events) throw new Error(`${call.name}: a transcript replay needs the call's events`);
  const live = buildTimeline(call.events.engine, call.events.llm);
  const notes: string[] = [];
  const audio = await callerFrames(call);
  const trace = audio.trace ?? call.vad ?? traceFromTurns(live.turns);
  if (trace.source === 'modelled') notes.push('VAD modelled from the turns (no caller audio)');
  if (options.vad === 'audio' && !audio.frames)
    throw new Error(`${call.name}: --vad audio needs the caller track`);
  const clock = new VirtualTime(call.events.startedAt);
  // The engine starts where the live one did: just before its opening.
  const startMs = Math.max(0, (live.agent[0]?.generatedAtMs ?? 0) - 5);
  const endMs = live.end?.atMs ?? live.durationMs;
  const commits: { live: boolean; text: string }[] = [];
  clock.install();
  try {
    await clock.runUntil(startMs);
    const responder = recordedResponder(
      liveReplies(live, call.profile),
      call.profile,
      (ms, signal) =>
        new Promise((resolve) => {
          const cancel = clock.setTimeout(resolve, ms);
          signal.addEventListener('abort', () => (cancel(), resolve()), { once: true });
        }),
      () => clock.callTime(),
    );
    const vad: VadAnalyzerFactory =
      options.vad === 'audio'
        ? createEnergyVad(call.profile.vad)
        : traceVad(trace, clock, call.profile.vad, clock.epochMs);
    const run = replayEngine({
      clock,
      zero: clock.epochMs,
      profile: call.profile,
      stt: scribeModel(clock, options.transcripts ?? live.transcripts, {
        zero: clock.epochMs,
        ...(options.commitLatencyMs === undefined
          ? {}
          : { commitLatencyMs: options.commitLatencyMs }),
        onCommit: (commit) => commits.push(commit),
      }),
      vad,
      detector: options.detector,
      inference: responder,
      output: outputTiming(call.profile, live),
      sessionId: `eval-${call.name}`,
    });
    // The carrier delivers the caller track (or silence) a frame at a time, as Twilio does.
    // On the caller track's frame grid even without its audio, so a VAD trace replays alike.
    const firstFrameAt = call.audioOffsetMs ?? trace.offsetMs ?? startMs;
    let index = 0;
    const next = () => {
      const at = firstFrameAt + (index + 1) * FRAME_MS;
      if (at > endMs || run.carrier.closed) return;
      clock.setTimeout(
        () => {
          run.carrier.caller.audio(audio.frames?.[index] ?? SILENT_FRAME);
          index++;
          next();
        },
        Math.max(0, at - clock.callTime()),
      );
    };
    next();
    clock.setTimeout(() => run.carrier.caller.hangup('caller_hangup'), endMs - clock.callTime());
    const started = run.engine.start();
    await clock.runUntil(endMs + (options.tailMs ?? 5_000));
    await started;
    await run.engine.ended;
    const timeline = buildTimeline(
      run.events,
      responder.requests.map((request, n) => ({ atMs: request.atMs, id: `replay-${n + 1}` })),
    );
    const unmatched = responder.requests.filter(
      (request) => request.answeredBy === 'unmatched',
    ).length;
    if (unmatched)
      notes.push(`${unmatched} LLM requests matched no live reply (neutral reply used)`);
    return {
      timeline,
      vad: trace,
      notes,
      requests: responder.requests,
      stats: {
        requests: responder.requests.length,
        unmatchedRequests: unmatched,
        modelledCommits: commits.filter((commit) => !commit.live && commit.text).length,
        commits: commits.length,
      },
    };
  } finally {
    clock.uninstall();
  }
}
