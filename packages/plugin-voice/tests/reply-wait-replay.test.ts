import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent, SpeechOutput } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import {
  TurnTelemetryCollector,
  type TurnTelemetry,
} from '../../plugin-observability/src/turn-telemetry.ts';
import { driverHarness, sleep, slowAgent } from '../../eval/src/replay-kit/index.ts';

/**
 * Wave 8 fix 3, latency-evidence C: on Maya call f3363705 (2026-10-07) the turn summaries showed
 * ~0.9 s between `firstSegmentMs` (the reply's first line ready) and `firstAudioMs` on turns with
 * no search, with TTS first byte ~146 ms. Replayed through the engine's turn driver, scheduler,
 * speech projector and turn latency, folded by the same turn-summary collector the worker uses:
 *
 * | turn | vadStop→final | stt | queue | firstSegment | firstAudio | TTS first byte |
 * | 3    | 839           | 1   | 0     | 1435         | 2424       | ~146           |
 * | 4    | 767           | 0   | 1     | 1318         | 2234       | ~146           |
 */
const LIVE = [
  { turn: 'turn-3', vadStopToFinalMs: 839, sttMs: 1, firstSegmentMs: 1435, firstAudioMs: 2424 },
  { turn: 'turn-4', vadStopToFinalMs: 767, sttMs: 1, firstSegmentMs: 1318, firstAudioMs: 2234 },
];
const TTS_FIRST_BYTE_MS = 146;

async function replay(live: (typeof LIVE)[number]) {
  const clock = new FakeClock();
  const agent = slowAgent(clock, { llmMs: live.firstSegmentMs });
  const h = driverHarness(clock, agent.behavior, {
    ttsMs: TTS_FIRST_BYTE_MS,
    playMs: 2000,
    timing: { hangoverMs: 200 },
  });
  const summaries = new Map<string, TurnTelemetry>();
  const collector = new TurnTelemetryCollector({
    includeText: true,
    emit: (turn) => summaries.set(turn.turnId, turn),
  });
  const events: EngineEvent[] = [];
  h.bus.onEngine((event) => {
    events.push(event);
    collector.engine(event);
  });
  await h.greet();
  // The caller's last voiced audio: the VAD reports its stop, the final transcript follows.
  h.latency.noteVadStop();
  await clock.advanceAsync(live.vadStopToFinalMs);
  h.latency.noteFinalStt();
  await clock.advanceAsync(live.sttMs);
  h.turn.stopped(live.turn, 'Tell me about Zagreb.');
  await clock.advanceAsync(10_000);
  collector.flush();
  return { summary: summaries.get(live.turn)!, events };
}

describe('fix 3: where the ~0.9 s between reply text and first audio goes (latency-evidence C)', () => {
  it.each(LIVE)('$turn: no engine wait between the first line and its audio', async (live) => {
    const { summary } = await replay(live);
    expect(summary).toMatchObject({
      vadStopToFinalMs: live.vadStopToFinalMs,
      firstSegmentMs: live.firstSegmentMs,
    });
    // The replay lands within the 3 ms of carrier write the live call also had.
    expect(live.firstAudioMs - summary.firstAudioMs!).toBeGreaterThanOrEqual(0);
    expect(live.firstAudioMs - summary.firstAudioMs!).toBeLessThanOrEqual(3);
    // The first line reached the carrier at its TTS first byte: nothing held it, no filler.
    expect(summary.segments[0]).toMatchObject({
      ttsFirstByteMs: TTS_FIRST_BYTE_MS,
      carrierFirstAudioMs: 0,
    });
    // The "gap" is the two fields' different origins: firstSegmentMs is timed from the reply
    // starting, firstAudioMs from the VAD stop, so their difference also holds the endpoint wait.
    const gap = summary.firstAudioMs! - summary.firstSegmentMs!;
    expect(gap).toBe(
      summary.vadStopToFinalMs! + summary.sttFinalizeMs! + summary.queueMs! + TTS_FIRST_BYTE_MS,
    );
  });
});

/** An output that synthesises ahead (`prepare`), as the native one does: TTS first byte `ttsMs`. */
function preparingOutput(clock: FakeClock, ttsMs: number) {
  const ready = new Map<string, Promise<void>>();
  const audio: { text: string; atMs: number }[] = [];
  const output: SpeechOutput = {
    async prepare(segment) {
      if (!ready.has(segment.id)) ready.set(segment.id, sleep(clock, ttsMs));
    },
    async play(segment, { signal, report }) {
      if (!ready.has(segment.id)) ready.set(segment.id, sleep(clock, ttsMs));
      await ready.get(segment.id);
      if (signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
      audio.push({ text: segment.text, atMs: clock.now() });
      report?.('sent', 'estimated');
      await sleep(clock, 1500, signal);
      return signal.aborted
        ? { state: 'interrupted', evidence: 'estimated' }
        : { state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  };
  return { output, audio };
}

describe('fix 3: a held reply plays the moment the caller is confirmed silent', () => {
  it('is synthesised while held, so it plays at the release itself, not a TTS first byte later', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const { output, audio } = preparingOutput(clock, 250);
    const h = driverHarness(clock, agent.behavior, { output, ttsMs: 250, playMs: 1500 });
    await h.greet();
    audio.length = 0;
    const t0 = clock.now();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(100);
    // A cough: the VAD opens a turn and the reply, ready at 300 ms, is held.
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    await clock.advanceAsync(300);
    h.turn.vad('vad.stop');
    await clock.advanceAsync(400);
    // Confirmed silent: the recogniser closes the utterance with no words.
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (line: unknown) => void logged.push(String(line)),
    );
    h.bus.observe({ type: 'stt', atMs: clock.now(), event: { type: 'end-of-turn' } });
    vi.restoreAllMocks();
    await clock.advanceAsync(5000);
    expect(audio.map((line) => [line.text, line.atMs - t0])).toEqual([['Answer: rule yes.', 800]]);
    // The hold's own wait is logged with it: 700 ms held, released 400 ms after the VAD went quiet.
    expect(logged.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        event: 'reply_hold_released',
        turnId: 'turn-2',
        reason: 'no-words',
        heldMs: 700,
        quietMs: 400,
      }),
    ]);
  });

  it('an unheld reply starts at its TTS first byte', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const { output, audio } = preparingOutput(clock, 250);
    const h = driverHarness(clock, agent.behavior, { output, ttsMs: 250, playMs: 1500 });
    await h.greet();
    audio.length = 0;
    const t0 = clock.now();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(5000);
    expect(audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: rule yes.', 300 + 250],
    ]);
  });
});
