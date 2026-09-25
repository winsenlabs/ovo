import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { SttEvent, TurnDecision } from '@winsendotai/ovo-contracts';
import { createTurnDetector } from '../src/index.ts';

type Script = readonly SttEvent[];
type Deepgram = { type: 'SpeechStarted' } | { type: 'UtteranceEnd' } | {
  type: 'Results'; channel: { alternatives: [{ transcript: string }] }; is_final: boolean; speech_final: boolean;
};
type Assembly = { type: 'SpeechStarted' } | { type: 'Turn'; turn_order: number; transcript: string; end_of_turn: boolean };
type Sarvam = { event: 'vad.speech_start' } | { event: 'vad.speech_end' } | { event: 'transcript.partial' | 'transcript.final'; text: string };

function fixture<T>(name: string): T[] {
  const lines = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ source: expect.stringMatching(/^https:\/\//), retrieved: '2026-09-25', verbatim: expect.any(Array), unconfirmed: expect.any(Array) });
  return lines.slice(1).map((entry) => {
    expect(entry.dir).toBe('in'); expect(entry.frame).toBeTypeOf('object');
    return entry.frame as T;
  });
}
const segment = (segmentId: string, revision: number, text: string, final: boolean): SttEvent => ({
  type: 'transcript', segment: { segmentId, revision, text, stability: final ? 'final' : 'interim' },
});

function deepgramScript(): Script {
  let segmentNumber = 0;
  let revision = 0;
  return fixture<Deepgram>('deepgram').flatMap((message): SttEvent[] => {
    if (message.type === 'SpeechStarted') return [{ type: 'speech-start' }];
    if (message.type === 'UtteranceEnd') return [{ type: 'utterance-end' }];
    const id = message.is_final ? `dg-${++segmentNumber}` : `dg-${segmentNumber + 1}`;
    const text = message.channel.alternatives[0]!.transcript;
    return [segment(id, ++revision, text, message.is_final),
      ...(message.speech_final ? [{ type: 'end-of-turn' } as const] : [])];
  });
}

function assemblyScript(): Script {
  let revision = 0;
  return fixture<Assembly>('assemblyai').flatMap((message): SttEvent[] => message.type === 'SpeechStarted'
    ? [{ type: 'speech-start' }]
    : [segment(`aai-${message.turn_order}`, ++revision, message.transcript, message.end_of_turn),
      ...(message.end_of_turn ? [{ type: 'end-of-turn' } as const] : [])]);
}

function sarvamScript(): Script {
  let revision = 0;
  let utterance = 0;
  return fixture<Sarvam>('sarvam').flatMap((message): SttEvent[] => {
    if (message.event === 'vad.speech_start') { utterance++; return [{ type: 'speech-start' }]; }
    if (message.event === 'vad.speech_end') return [{ type: 'speech-end' }];
    return [segment(`sar-${utterance}`, ++revision, message.text, message.event === 'transcript.final'),
      ...(message.event === 'transcript.final' ? [{ type: 'end-of-turn' } as const] : [])];
  });
}

function accepted(script: Script): string[] {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  const detector = createTurnDetector().create({ clock, vad: false, language: 'en-US', mode: 'faq' });
  detector.on((decision) => decisions.push(decision));
  for (const event of script) detector.observe({ type: 'stt', event, atMs: clock.now() });
  detector.dispose();
  return decisions.flatMap((decision) => decision.type === 'turn.stopped' && decision.input.kind === 'speech'
    ? [decision.input.text] : []);
}

it('normalizes three documented provider scripts into the same accepted turns', () => {
  for (const script of [deepgramScript(), assemblyScript(), sarvamScript()])
    expect(accepted(script)).toEqual(['my number is 98 45', 'yes']);
});
