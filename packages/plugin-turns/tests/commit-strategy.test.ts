import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { SpeechCapabilities, TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { DetectorConfigSchema, createTurnDetector } from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** An STT that finalises only on a host commit, like Scribe with commit_strategy=manual. */
const manualCommit: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};
/** An STT with its own end-of-turn, like AssemblyAI. */
const providerTurns: SpeechCapabilities = { ...manualCommit, turnSignals: ['end-of-turn'] };

function fixture(
  row: Record<string, unknown> = {},
  { vad = true, stt = manualCommit }: { vad?: boolean; stt?: SpeechCapabilities } = {},
) {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  const controller = createTurnDetector(row).create({
    clock,
    vad,
    language: 'en-IN',
    mode: 'agent',
    stt,
  });
  controller.on((decision) => decisions.push(decision));
  let revision = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (text: string, stability: 'interim' | 'final', segmentId = '0') =>
    send({
      type: 'stt',
      event: { type: 'transcript', segment: { segmentId, revision: ++revision, text, stability } },
    });
  /** VAD speech of `ms`, with the clock advanced across it. */
  const speak = (ms: number, interim?: string) => {
    send({ type: 'vad.start' });
    if (interim) transcript(interim, 'interim');
    clock.advance(ms);
    send({ type: 'vad.stop' });
  };
  const forced = () => decisions.filter((d) => d.type === 'force-endpoint').length;
  const stopped = () =>
    decisions.flatMap((d) =>
      d.type === 'turn.stopped' && d.input.kind === 'speech' ? [d.input.text] : [],
    );
  return { clock, decisions, send, transcript, speak, forced, stopped };
}

describe("'commit' turn strategy", () => {
  it('commits 50 ms after the VAD stop and ends the turn on the final, with no fixed wait', () => {
    const f = fixture();
    f.speak(600, 'mera naam');
    f.clock.advance(49);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
    f.transcript('mera naam Ravi hai', 'final');
    // The vad-timeout strategy would hold this turn until userSpeechTimeoutMs (600 ms) elapsed.
    expect(f.stopped()).toEqual(['mera naam Ravi hai']);
    expect(f.forced()).toBe(1);
  });

  it("is what 'auto' picks for a manual-commit STT, while provider-turn STTs keep vad-timeout", () => {
    const commit = fixture();
    commit.speak(600, 'haan');
    commit.clock.advance(50);
    commit.transcript('haan ji', 'final');
    expect(commit.stopped()).toEqual(['haan ji']);

    const timeout = fixture({}, { stt: providerTurns });
    timeout.speak(600, 'haan');
    // vad-timeout forces the endpoint at the VAD stop, then waits out userSpeechTimeoutMs.
    expect(timeout.forced()).toBe(1);
    timeout.transcript('haan ji', 'final');
    expect(timeout.stopped()).toEqual([]);
    timeout.clock.advance(600);
    expect(timeout.stopped()).toEqual(['haan ji']);
  });

  it('never commits a click shorter than minSpeechMs with nothing transcribed', () => {
    const f = fixture();
    f.speak(100);
    f.clock.advance(5_000);
    expect(f.forced()).toBe(0);
  });

  it('cancels the commit when the caller resumes inside the local silence', () => {
    const f = fixture();
    f.speak(400, 'kal');
    f.clock.advance(30);
    f.speak(400, 'kal subah');
    f.clock.advance(49);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
  });

  it('ends the turn on a provider final that lands before the commit', () => {
    const f = fixture({ strategy: 'commit' }, { stt: providerTurns });
    f.speak(600, 'theek');
    f.transcript('theek hai', 'final');
    expect(f.stopped()).toEqual(['theek hai']);
    expect(f.forced()).toBe(0);
  });

  it('commits when the interim stalls although line noise keeps the VAD open', () => {
    const f = fixture();
    f.send({ type: 'vad.start' });
    f.transcript('main payment', 'interim');
    f.clock.advance(1_000);
    f.transcript('main payment', 'interim');
    f.clock.advance(499);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
    // The VAD never stopped, but the final of the committed audio still ends the turn.
    f.transcript('main payment kar dunga', 'final');
    expect(f.stopped()).toEqual(['main payment kar dunga']);
  });

  it('ends on the interim text at the ceiling and drops that segment’s late final', () => {
    const f = fixture();
    f.speak(600, 'mujhe time chahiye');
    f.clock.advance(50);
    expect(f.forced()).toBe(1);
    f.clock.advance(599);
    expect(f.stopped()).toEqual([]);
    f.clock.advance(1);
    expect(f.stopped()).toEqual(['mujhe time chahiye']);
    f.transcript('mujhe time chahiye', 'final');
    expect(f.decisions.filter((d) => d.type === 'turn.started')).toHaveLength(1);
    // A new segment is a new turn as usual.
    f.speak(600);
    f.clock.advance(50);
    f.transcript('haan', 'final', '1');
    expect(f.stopped()).toEqual(['mujhe time chahiye', 'haan']);
  });

  it("runs without a VAD under 'auto' instead of refusing a manual-commit STT", () => {
    const f = fixture({}, { vad: false });
    f.transcript('hello', 'interim');
    f.clock.advance(1_500);
    expect(f.forced()).toBe(1);
    f.transcript('hello there', 'final');
    expect(f.stopped()).toEqual(['hello there']);
    expect(() => fixture({ strategy: 'provider' }, { vad: false })).toThrow(/end-of-turn/);
  });

  it('parses the commit settings with their POC defaults and rejects unknown keys', () => {
    expect(DetectorConfigSchema.parse({}).commit).toEqual({
      silenceMs: 50,
      minSpeechMs: 180,
      stallMs: 1500,
    });
    expect(DetectorConfigSchema.parse({ strategy: 'commit' }).strategy).toBe('commit');
    expect(() => DetectorConfigSchema.parse({ commit: { silence: 1 } })).toThrow();
    expect(() => DetectorConfigSchema.parse({ unknown: true })).toThrow();
  });

  it('a configured silence and a disabled stall fallback are honoured', () => {
    const f = fixture({ commit: { silenceMs: 200, stallMs: 0 } });
    f.send({ type: 'vad.start' });
    f.transcript('ek', 'interim');
    f.clock.advance(10_000);
    expect(f.forced()).toBe(0);
    f.send({ type: 'vad.stop' });
    f.clock.advance(199);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
  });
});
