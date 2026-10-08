import {
  MULAW_8K,
  type NetFixtureScript,
  type TurnDecision,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { DetectorConfigSchema, createTurnDetector } from '@winsendotai/ovo-plugin-turns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scribeCapabilitiesFor } from '../src/capabilities.ts';
import { CONFIDENCE_DEADLINE_MS, CONFIDENCE_WAIT_MS } from '../src/confidence.ts';
import { ElevenLabsStt } from '../src/provider.ts';
import {
  RETRIEVED,
  SOURCE,
  committed,
  committedWords,
  partial,
  sessionStarted,
} from '../src/testing.ts';

// Replays a caller turn through Scribe and the 'commit' turn detector on one clock, with the
// turn-detector row of Maya's call f3363705 (/tmp/ovo/latency-evidence.md): commit.silenceMs 450,
// so its vadStop->final of 766 to 839 ms is 316 to 389 ms from the commit to the committed
// transcript. The detector ends the turn on the interim text if no final follows its commit within
// userSpeechTimeoutMs; the confidence wait must never push the final past that ceiling.

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

const MAYA = {
  strategy: 'commit',
  commit: { silenceMs: 450, minSpeechMs: 180, stallMs: 1500 },
  minWordsWhileBotSpeaking: 3,
};
const CEILING_MS = DetectorConfigSchema.parse(MAYA).userSpeechTimeoutMs;
/** Under the detector's 1.5 s stall fallback, so the commit follows the VAD stop. */
const SPOKEN_MS = 800;

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

/**
 * The caller says "I will pay on Friday." for 0.8 s; the provider's committed transcript lands
 * `commitToFinalMs` after the commit and its word-level message `wordsAfterMs` after that (never,
 * when undefined). Returns the turn's text and when it stopped, in ms after the commit.
 */
async function replay(commitToFinalMs: number, wordsAfterMs?: number) {
  const clock = new FakeClock();
  const said = 'I will pay on Friday.';
  const script: NetFixtureScript[] = [
    {
      host: 'api.elevenlabs.io',
      source: SOURCE,
      retrieved: RETRIEVED,
      steps: [
        { expect: 'ws-open', url: /include_timestamps=true/ },
        { send: sessionStarted() },
        {
          expect: 'ws-send',
          match: 'json',
          where: { message_type: 'input_audio_chunk', commit: false },
          repeat: 'until-next',
        },
        { send: partial('I will pay') },
        {
          expect: 'ws-send',
          match: 'json',
          where: { message_type: 'input_audio_chunk', commit: true },
        },
        { delayMs: commitToFinalMs },
        { send: committed(said) },
        ...(wordsAfterMs === undefined
          ? []
          : [{ delayMs: wordsAfterMs }, { send: committedWords(said, [-0.05, -0.1, -0.05]) }]),
      ],
    },
  ];
  const detector = createTurnDetector(MAYA).create({
    clock,
    vad: true,
    language: 'en-IN',
    mode: 'agent',
    stt: scribeCapabilitiesFor({}),
  });
  const observe = (event: WithoutTime<VoiceEvent>) =>
    detector.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const stt = await new ElevenLabsStt(
    createFixtureNet(script, { clock }),
    'fixture-key',
    {},
    clock,
  ).start({
    sessionId: 'scribe-turn-ceiling',
    format: MULAW_8K,
    language: 'en-IN',
    signal: new AbortController().signal,
    onEvent: (event) => observe({ type: 'stt', event }),
    onUsage: () => undefined,
  });
  let committedAt = -1;
  const stopped: Array<{ text: string; afterCommitMs: number }> = [];
  detector.on((decision: TurnDecision) => {
    if (decision.type === 'force-endpoint') {
      committedAt = clock.now();
      void stt.forceEndpoint!();
    }
    if (decision.type === 'turn.stopped' && decision.input.kind === 'speech')
      stopped.push({ text: decision.input.text, afterCommitMs: clock.now() - committedAt });
  });
  observe({ type: 'vad.start' });
  await stt.write(new Uint8Array(400).fill(1));
  await clock.advanceAsync(SPOKEN_MS);
  observe({ type: 'vad.stop' });
  await clock.advanceAsync(3_000);
  await stt.cancel('done');
  return stopped;
}

describe('the confidence wait against the commit ceiling (Wave 8, call f3363705)', () => {
  it(`stays well inside the ${CEILING_MS} ms ceiling on the slowest live commit (389 ms)`, async () => {
    // A prompt word-level message, 5 ms behind its commit: 5 ms added to the turn.
    expect(await replay(389, 5)).toEqual([{ text: 'I will pay on Friday.', afterCommitMs: 394 }]);
  });

  it(`costs at most ${CONFIDENCE_WAIT_MS} ms when the word-level message never comes`, async () => {
    expect(await replay(389)).toEqual([
      { text: 'I will pay on Friday.', afterCommitMs: 389 + CONFIDENCE_WAIT_MS },
    ]);
  });

  it('never waits past the deadline, so a slow commit still ends the turn on its final', async () => {
    // Regression: 580 ms to the commit plus a full wait is past the ceiling, which ended the turn
    // on "I will pay" and dropped the final and its confidence.
    const slow = CONFIDENCE_DEADLINE_MS + 80;
    expect(slow + CONFIDENCE_WAIT_MS).toBeGreaterThan(CEILING_MS);
    expect(await replay(slow)).toEqual([{ text: 'I will pay on Friday.', afterCommitMs: slow }]);
    expect(await replay(CONFIDENCE_DEADLINE_MS - 10)).toEqual([
      { text: 'I will pay on Friday.', afterCommitMs: CONFIDENCE_DEADLINE_MS },
    ]);
  });
});
