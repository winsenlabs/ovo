import type {
  SpeechCapabilities,
  SpeechKindV2,
  TurnDecision,
  UserTurnController,
  VoiceEvent,
} from '../../../contracts/src/index.ts';
import { FakeClock } from '../../../conformance/src/drivers/fake-clock.ts';
import {
  createModelTurnDetector,
  createTurnDetector,
  type EndOfTurnModel,
  type ModelGatedTurnController,
  type ModelGateStats,
} from '../../../plugin-turns/src/index.ts';
import { FRAME_MS, FRAME_SAMPLES } from './audio.ts';
import { timelineEvents, type Timeline } from './timeline.ts';

/**
 * Replays a whole call through a turn detector (Wave 13, T2): the rules detector as configured by
 * `row`, or the model gate over it. The detector hears what it heard live: every transcript at the
 * time the engine got it (each final followed by Scribe's end-of-turn), the VAD's starts and stops,
 * and the agent's speech as it was played (bot.started / bot.stopped, questions and fillers
 * marked). An audio model also gets the caller audio, 20 ms frames in real time.
 *
 * Not modelled, and so the same for every variant: the agent's replies keep their live timing
 * (the caller's words answered them, so they cannot move), and Scribe's finals keep theirs (the
 * live detector's commits asked for them; a detector committing sooner would get them up to the
 * difference sooner). Model inference takes no time on the replay's clock: its measured cost is
 * reported beside the endpoint latencies.
 */
export interface Variant {
  name: string;
  /** The rules detector's row (and, with a model, the gate's `model` settings). */
  row: Record<string, unknown>;
  model?: EndOfTurnModel;
}

export interface ReplayResult {
  variant: string;
  call: string;
  endpoints: { at: number; text: string; reason?: string }[];
  resets: { at: number; reason: string; text?: string }[];
  interrupts: number;
  stats?: ModelGateStats;
}

/** Scribe v2 realtime with manual commits, as production runs it. */
const SCRIBE: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};

const KINDS: Record<string, SpeechKindV2> = {
  response: 'response',
  acknowledgment: 'acknowledgment',
  disclosure: 'disclosure',
};

export async function replayCall(
  timeline: Timeline,
  variant: Variant,
  language = 'en-IN',
): Promise<ReplayResult> {
  const events = timelineEvents(timeline);
  const begin = Math.min(0, events[0]?.at ?? 0) - 1000;
  const clock = new FakeClock(begin);
  const input = { clock, vad: true, language, mode: 'agent' as const, stt: SCRIBE };
  const gated = variant.model
    ? createModelTurnDetector(variant.row, variant.model).create(input)
    : undefined;
  const controller: UserTurnController = gated ?? createTurnDetector(variant.row).create(input);
  const result: ReplayResult = {
    variant: variant.name,
    call: timeline.label,
    endpoints: [],
    resets: [],
    interrupts: 0,
  };
  controller.on((decision: TurnDecision) => {
    if (decision.type === 'turn.stopped' && decision.input.kind === 'speech')
      result.endpoints.push({
        at: clock.now(),
        text: decision.input.text,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    else if (decision.type === 'turn.reset')
      result.resets.push({
        at: clock.now(),
        reason: decision.reason,
        ...(decision.text ? { text: decision.text } : {}),
      });
    else if (decision.type === 'interrupt') result.interrupts++;
  });
  let revision = 0;
  const observe = (event: Omit<VoiceEvent, 'atMs'>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const audio =
    gated && variant.model?.input === 'audio' && timeline.audio ? timeline.audio : undefined;
  let frame = 0;
  const frames = audio ? Math.floor(audio.pcm.length / FRAME_SAMPLES) : 0;
  /** The end of audio frame `i` on the timeline: it is pushed once complete. */
  const frameEnd = (i: number) => audio!.offsetMs + (i + 1) * FRAME_MS;
  const until = async (at: number) => {
    // Audio frames due before `at`, each at its own time, predictions settled as they are made.
    while (audio && frame < frames && frameEnd(frame) <= at) {
      clock.advance(Math.max(0, frameEnd(frame) - clock.now()));
      gated!.audio(audio.pcm.subarray(frame * FRAME_SAMPLES, (frame + 1) * FRAME_SAMPLES), 8000);
      frame++;
      await gated!.settled();
    }
    // Timers due before `at`, in 10 ms steps so a prediction started by one settles in order.
    while (clock.now() < at) {
      clock.advance(Math.min(10, at - clock.now()));
      if (gated) await gated.settled();
    }
  };
  for (const event of events) {
    await until(event.at);
    switch (event.type) {
      case 'transcript':
        observe({
          type: 'stt',
          event: {
            type: 'transcript',
            segment: {
              segmentId: event.seg,
              revision: ++revision,
              text: event.text,
              stability: event.final ? 'final' : 'interim',
            },
          },
        } as Omit<VoiceEvent, 'atMs'>);
        // Scribe's lock(): the committed transcript, then its end-of-turn.
        if (event.final)
          observe({ type: 'stt', event: { type: 'end-of-turn' } } as Omit<VoiceEvent, 'atMs'>);
        break;
      case 'vad.start':
      case 'vad.stop':
        observe({ type: event.type });
        break;
      case 'agent.start':
        gated?.agentSaid(event.text);
        observe({
          type: 'bot.started',
          epoch: event.epoch,
          kind: KINDS[event.kind] ?? 'response',
          ...(event.question ? { question: true } : {}),
          ...(event.filler ? { filler: true } : {}),
        } as Omit<VoiceEvent, 'atMs'>);
        break;
      case 'agent.stop':
        observe({
          type: 'bot.stopped',
          epoch: event.epoch,
          kind: KINDS[event.kind] ?? 'response',
        } as Omit<VoiceEvent, 'atMs'>);
        break;
    }
  }
  await until(Math.max(clock.now(), timeline.durationMs) + 10_000);
  if (gated) result.stats = structuredClone((gated as ModelGatedTurnController).stats);
  controller.dispose();
  return result;
}
