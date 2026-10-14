import { describe, expect, it } from 'vitest';
import { speechLikePcm16 } from '../../../../conformance/src/drivers/audio-gen.ts';
import { alignTrack, draftUtterances, unheardTurns } from '../align.ts';
import { parseCallLog } from '../call-log.ts';
import { speechRegions } from '../vad.ts';
import { readWav, slicePcm, writeWav, type Pcm } from '../wav.ts';

/** Line hiss (about -70 dBFS, like a carrier track's gaps) with speech-like bursts, 8 kHz. */
function track(bursts: readonly [number, number][], totalMs: number): Pcm {
  const samples = Int16Array.from({ length: totalMs * 8 }, (_, i) => ((i * 7919) % 17) - 8);
  for (const [index, [start, end]] of bursts.entries())
    samples.set(speechLikePcm16({ seed: index + 1, ms: end - start, rate: 8_000 }), start * 8);
  return { sampleRate: 8000, samples };
}

const START = '2026-10-14T17:58:48.971Z';
const epoch = Date.parse(START);

function line(type: string, atMs: number, event?: Record<string, unknown>): string {
  return JSON.stringify({
    callId: 'call-1',
    at: new Date(epoch + atMs).toISOString(),
    type,
    payload: event ? { atMs: epoch + atMs, event } : {},
  });
}

describe('caller-track segmentation', () => {
  it('finds the speech, joins breaths and drops clicks', () => {
    // A 300 ms breath joins the first two bursts; the 30 ms click is noise.
    const pcm = track(
      [
        [1000, 1800],
        [2100, 2600],
        [4000, 4030],
        [6000, 7000],
      ],
      9000,
    );
    const regions = speechRegions(pcm, { mergeGapMs: 400, padMs: 80 });
    expect(regions.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [920, 2680],
      [5920, 7080],
    ]);
  });

  it('round-trips a WAV and cuts it by milliseconds', () => {
    const pcm = track([[100, 300]], 500);
    const back = readWav(writeWav(pcm));
    expect(back.sampleRate).toBe(8000);
    expect([...back.samples]).toEqual([...pcm.samples]);
    expect(slicePcm(back, 100, 300).samples.length).toBe(1600);
  });
});

describe('the event log and the alignment', () => {
  const jsonl = [
    line('session.started', 0),
    // The VAD opened each turn 200 ms after speech began; the track starts 500 ms after the
    // session, so call time = track time + 500.
    line('engine.event', 1720, { type: 'user.turn', phase: 'started', turnId: 'turn-1' }),
    line('engine.event', 3300, {
      type: 'user.transcript',
      stability: 'final',
      segmentId: '0',
      text: 'Hey Maya',
    }),
    line('engine.event', 3310, {
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-1',
      text: 'Hey Maya',
      endpointMs: 400,
      endpointRule: 'complete',
    }),
    line('engine.event', 6720, { type: 'user.turn', phase: 'started', turnId: 'turn-2' }),
    line('engine.event', 7900, {
      type: 'user.transcript',
      stability: 'final',
      segmentId: '1',
      text: 'Ah, aber',
    }),
    line('engine.event', 7950, {
      type: 'user.turn',
      phase: 'reset',
      turnId: 'turn-2',
      text: '.',
      resetReason: 'backchannel',
    }),
  ].join('\n');

  it('reads turns and finals relative to the session start', () => {
    const log = parseCallLog(jsonl);
    expect(log.callId).toBe('call-1');
    expect(log.turns).toEqual([
      {
        turnId: 'turn-1',
        startedMs: 1720,
        stoppedMs: 3310,
        text: 'Hey Maya',
        endpointMs: 400,
        endpointRule: 'complete',
      },
      { turnId: 'turn-2', startedMs: 6720, stoppedMs: 7950, text: '.', resetReason: 'backchannel' },
    ]);
    expect(log.finals.map((final) => [final.atMs, final.text])).toEqual([
      [3300, 'Hey Maya'],
      [7900, 'Ah, aber'],
    ]);
    expect(() => parseCallLog(line('engine.event', 0, {}))).toThrow('no session.started');
  });

  it('recovers the track offset from the turn starts and attaches turns and finals', () => {
    const pcm = track(
      [
        [1020, 2500],
        [6020, 7000],
      ],
      9000,
    );
    const regions = speechRegions(pcm, { mergeGapMs: 400, padMs: 80 });
    const log = parseCallLog(jsonl);
    const alignment = alignTrack(regions, log.turns, 80);
    expect(alignment).toMatchObject({ offsetMs: 500, matched: 2, turns: 2, medianErrorMs: 0 });
    const drafts = draftUtterances('c1', regions, log, alignment);
    expect(
      drafts.map((d) => [d.id, d.startMs, d.productionTurnIds, d.productionFinals.length]),
    ).toEqual([
      ['c1-u01', 1440, ['turn-1'], 1],
      ['c1-u02', 6440, ['turn-2'], 1],
    ]);
    // Turn 2 was spoken; a turn over silence later in the call was not.
    expect(unheardTurns(log, regions, alignment)).toEqual([]);
    const silent = parseCallLog(
      [
        jsonl,
        line('engine.event', 12_000, { type: 'user.turn', phase: 'started', turnId: 'turn-3' }),
        line('engine.event', 13_500, {
          type: 'user.turn',
          phase: 'stopped',
          turnId: 'turn-3',
          text: 'Question 4.',
        }),
      ].join('\n'),
    );
    expect(unheardTurns(silent, regions, alignment)).toEqual([
      {
        turn: expect.objectContaining({ turnId: 'turn-3', text: 'Question 4.' }),
        audioStartMs: 9_500,
        audioEndMs: 13_000,
      },
    ]);
  });
});
