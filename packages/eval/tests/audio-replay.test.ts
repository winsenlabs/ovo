import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createScriptedInference,
  createScriptedStt,
  speechLikePcm16,
} from '@winsendotai/ovo-conformance/drivers';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/corpus/load.ts';
import { replayAudio } from '../src/replay/audio.ts';
import { chooseDetector } from '../src/replay/detectors.ts';
import { scoreCall } from '../src/score/scorecard.ts';

/** 8 kHz mono 16-bit PCM: silence, and speech-like audio where the caller speaks. */
function wav(ms: number, speech: [number, number]): Buffer {
  const samples = new Int16Array((ms * 8000) / 1000);
  samples.set(speechLikePcm16({ seed: 7, ms: speech[1] - speech[0], rate: 8000 }), speech[0] * 8);
  const file = Buffer.alloc(44 + samples.length * 2);
  file.write('RIFF', 0);
  file.writeUInt32LE(36 + samples.length * 2, 4);
  file.write('WAVEfmt ', 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(8000, 24);
  file.writeUInt32LE(16000, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36);
  file.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => file.writeInt16LE(sample, 44 + index * 2));
  return file;
}

/** A call export: the opening line, then the caller hangs up. */
function events(): string {
  const start = Date.parse('2026-10-01T10:00:00.000Z');
  const text = "Hi! I'm Maya. Where are you thinking of going?";
  const speech = (sequence: number, atMs: number, phase: string) => ({
    type: 'speech',
    evidence: {
      sequence,
      segmentId: 'speech-1',
      text,
      epoch: 1,
      kind: 'response',
      phase,
      at: start + atMs,
    },
  });
  const lines: [number, string, unknown][] = [
    [0, 'session.started', { source: 'fixture' }],
    [
      100,
      'engine.event',
      {
        type: 'timing',
        key: 'text_aggregation',
        turnId: 'opening-1',
        segmentId: 'speech-1',
        atMs: start + 100,
        ms: 1,
      },
    ],
    [100, 'engine.event', speech(1, 100, 'generated')],
    [120, 'engine.event', speech(2, 120, 'sent')],
    [800, 'engine.event', speech(3, 800, 'completed')],
    [5000, 'engine.event', { type: 'end', reason: 'caller_hangup' }],
    [5000, 'session.ended', { reason: 'caller_hangup', outcome: 'caller_ended' }],
  ];
  return lines
    .map(([atMs, type, payload], index) =>
      JSON.stringify({
        callId: 'audio-1',
        sequence: index + 1,
        at: new Date(start + atMs).toISOString(),
        type,
        payload: type === 'engine.event' ? { atMs: start + atMs, event: payload } : payload,
      }),
    )
    .join('\n');
}

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('an audio replay with a live LLM', () => {
  it('scores the requests the engine made to the live LLM, not the unused recorded responder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ovo-eval-audio-'));
    dirs.push(dir);
    await writeFile(join(dir, 'call1-events.jsonl'), events());
    // The caller speaks from 0.9 s to 1.8 s of a 3.2 s track.
    await writeFile(join(dir, 'call1-caller.wav'), wav(3200, [900, 1800]));
    await writeFile(
      join(dir, 'corpus.json'),
      JSON.stringify({ calls: { call1: { audioOffsetMs: 0 } } }),
    );
    const [call] = await loadCorpus(dir);
    const detector = await chooseDetector('rules', call!.profile.detector);
    const stt = createScriptedStt();
    const inference = createScriptedInference([
      { kind: 'text', text: 'Paris is lovely in December.' },
    ]);
    const began = Date.now();
    const replay = replayAudio(call!, { detector: detector.factory, stt, inference });
    const session = await stt.session(0);
    // The STT's words for the tone, as its speech ends (call time 0 is ~0.1 s before `began`).
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, began + 1750 - Date.now())));
    session.say('I want to go to Paris.');
    const result = await replay;
    const score = scoreCall({
      call: 'call1',
      mode: 'audio',
      timeline: result.timeline,
      profile: call!.profile,
    });
    expect(inference.requests.length).toBeGreaterThan(0);
    expect(result.stats.requests).toBe(inference.requests.length);
    expect(result.requests.every((request) => request.answeredBy === 'live')).toBe(true);
    expect(score.metrics.llmRequests).toBe(inference.requests.length);
    expect(score.metrics.answeredTurns).toBe(1);
    expect(score.metrics.llmPerTurn).toBe(inference.requests.length);
    expect(result.notes[0]).toMatch(/^live STT and LLM;/);
  }, 20_000);
});
