import { describe, expect, it } from 'vitest';
import { describeTurnDetector } from '@winsendotai/ovo-conformance';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { SpeechCapabilities, TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import {
  createModelTurnDetector,
  modelTurnDetectorPlugin,
  type EndOfTurnModel,
  type EndOfTurnRequest,
} from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** Scribe: finalises only on a host commit. */
const scribe: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};

/** A model answering `probability(text)` (a constant by default), recording its requests. */
function fakeModel(
  probability: number | ((request: EndOfTurnRequest) => number),
  input: 'audio' | 'text' = 'text',
) {
  const requests: EndOfTurnRequest[] = [];
  const model: EndOfTurnModel & { requests: EndOfTurnRequest[] } = {
    name: 'fake',
    input,
    requests,
    threshold: (language) => (language.startsWith('ta') ? undefined : 0.5),
    predict: async (request) => {
      requests.push(request);
      return typeof probability === 'number' ? probability : probability(request);
    },
  };
  return model;
}

/** The same, answering synchronously (the conformance driver never awaits). */
function syncModel(probability: number): EndOfTurnModel {
  return { name: 'sync', input: 'text', threshold: () => 0.5, predict: () => probability };
}

function fixture(model: EndOfTurnModel, row: Record<string, unknown> = {}, language = 'en-IN') {
  const clock = new FakeClock();
  const controller = createModelTurnDetector(row, model).create({
    clock,
    vad: true,
    language,
    mode: 'agent',
    stt: scribe,
  });
  const decisions: TurnDecision[] = [];
  let revision = 0;
  let segment = 0;
  let pending: string | undefined;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (text: string, stability: 'interim' | 'final') =>
    send({
      type: 'stt',
      event: {
        type: 'transcript',
        segment: { segmentId: String(segment), revision: ++revision, text, stability },
      },
    });
  controller.on((decision) => {
    decisions.push(decision);
    // Scribe answers a host commit with its final 300 ms later.
    if (decision.type === 'force-endpoint' && pending !== undefined) {
      const text = pending;
      pending = undefined;
      clock.setTimeout(() => {
        transcript(text, 'final');
        send({ type: 'stt', event: { type: 'end-of-turn' } });
        segment++;
      }, 300);
    }
  });
  /** The caller says `text` over `ms` of VAD speech, then goes quiet. */
  const say = (text: string, ms = 800) => {
    pending = text;
    send({ type: 'vad.start' });
    clock.advance(ms / 2);
    transcript(text, 'interim');
    clock.advance(ms / 2);
    send({ type: 'vad.stop' });
  };
  /** Runs the clock `ms` on, letting each prediction resolve as it is made. */
  const wait = async (ms: number) => {
    for (let step = 0; step < ms; step += 10) {
      clock.advance(10);
      await controller.settled();
    }
  };
  const stops = () =>
    decisions.flatMap((d) =>
      d.type === 'turn.stopped' && d.input.kind === 'speech'
        ? [{ text: d.input.text, reason: d.reason }]
        : [],
    );
  const starts = () => decisions.filter((d) => d.type === 'turn.started').length;
  // Mid-call: the opening has played.
  send({ type: 'bot.started', epoch: 0, kind: 'response' });
  send({ type: 'bot.stopped', epoch: 0, kind: 'response' });
  return { clock, controller, decisions, send, say, wait, stops, starts };
}

describeTurnDetector('model gate (a model that reads every turn as finished)', () =>
  createModelTurnDetector({}, syncModel(1)),
);

describe('model gate (Wave 13, T1)', () => {
  it('ends a turn the model reads as finished as the rules do, after reading it', async () => {
    const model = fakeModel(0.9);
    const f = fixture(model);
    f.say('What is the capital of Croatia?');
    await f.wait(1000);
    expect(f.stops()).toEqual([{ text: 'What is the capital of Croatia?', reason: 'complete' }]);
    expect(model.requests).toEqual([
      { text: 'What is the capital of Croatia?', language: 'en-IN' },
    ]);
    expect(f.controller.stats.predictions).toEqual([0.9]);
  });

  it('holds a turn read as unfinished, and words in the hold continue the same turn', async () => {
    const model = fakeModel(({ text }) => (text.endsWith('Vienna.') ? 0.2 : 0.8));
    const f = fixture(model);
    f.say('We are going to Budapest and Vienna.');
    await f.wait(1500);
    expect(f.stops()).toEqual([]);
    expect(f.controller.stats.held).toEqual(['We are going to Budapest and Vienna.']);
    f.say('Zagreb too.');
    await f.wait(1000);
    expect(f.starts()).toBe(1);
    expect(f.stops()).toEqual([
      { text: 'We are going to Budapest and Vienna. Zagreb too.', reason: 'complete' },
    ]);
    expect(model.requests.at(-1)!.text).toBe('We are going to Budapest and Vienna. Zagreb too.');
    expect(f.controller.stats.merged).toBe(1);
  });

  it('announces partials of the held turn with its earlier words', async () => {
    const f = fixture(fakeModel(({ text }) => (text.includes('January') ? 0.9 : 0.1)));
    f.say('Our dates are');
    await f.wait(1000);
    f.say('the 22nd of December to the 5th of January.');
    const partials = f.decisions.flatMap((d) => (d.type === 'turn.partial' ? [d.text] : []));
    expect(partials.at(-1)).toBe('Our dates are the 22nd of December to the 5th of January.');
  });

  it('ends a held turn after holdMs with what it has (reason hold)', async () => {
    const f = fixture(fakeModel(0.1), { model: { holdMs: 2000 } });
    f.say('I was thinking that maybe we could');
    await f.wait(1000);
    expect(f.stops()).toEqual([]);
    await f.wait(2000);
    expect(f.stops()).toEqual([{ text: 'I was thinking that maybe we could', reason: 'hold' }]);
  });

  it('keeps holding through a backchannel, and ends at the original deadline', async () => {
    const f = fixture(fakeModel(0.1), { model: { holdMs: 2000 } });
    f.say('So the thing is');
    await f.wait(600);
    const heldAt = f.clock.now();
    // Noise in the hold: VAD speech with no words, which the rules drop.
    f.send({ type: 'vad.start' });
    await f.wait(200);
    f.send({ type: 'vad.stop' });
    await f.wait(4000);
    expect(f.stops()).toEqual([{ text: 'So the thing is', reason: 'hold' }]);
    expect(f.starts()).toBe(1);
    expect(heldAt).toBeGreaterThan(0);
  });

  it('ends short answers unread, and holds words the STT broke off whatever the model says', async () => {
    const model = fakeModel(0.99);
    const f = fixture(model, { model: { holdMs: 1000 } });
    f.say('Yes.', 300);
    await f.wait(1000);
    expect(f.stops().map((s) => s.text)).toEqual(['Yes.']);
    expect(model.requests).toEqual([]);
    expect(f.controller.stats.bypassed.shortAnswer).toBe(1);
    f.say('What happens if any-');
    // The rules' own pauseHoldMs (2.5 s) for broken-off words, then the gate's hold.
    await f.wait(6000);
    expect(f.stops().at(-1)).toEqual({ text: 'What happens if any-', reason: 'hold' });
    expect(f.controller.stats.held).toEqual(['What happens if any-']);
  });

  it('reads a held turn again as the silence grows (recheckMs), ending it once it reads finished', async () => {
    let calls = 0;
    // Unfinished on the first reading, finished on the second.
    const model = fakeModel(() => (++calls >= 2 ? 0.9 : 0.1), 'audio');
    const f = fixture(model, { model: { holdMs: 2500, recheckMs: 500 } });
    const frame = new Int16Array(160).fill(800);
    let stoppedAt: number | undefined;
    f.controller.on((d) => {
      if (d.type === 'turn.stopped') stoppedAt = f.clock.now();
    });
    f.send({ type: 'vad.start' });
    for (let t = 0; t < 4000; t += 20) {
      f.controller.audio(frame, 8000);
      if (t === 400)
        f.send({
          type: 'stt',
          event: {
            type: 'transcript',
            segment: { segmentId: '0', revision: 1, text: 'We fly on the', stability: 'interim' },
          },
        });
      if (t === 800) f.send({ type: 'vad.stop' });
      if (t === 1100) {
        f.send({
          type: 'stt',
          event: {
            type: 'transcript',
            segment: {
              segmentId: '0',
              revision: 2,
              text: 'We fly on the 22nd.',
              stability: 'final',
            },
          },
        });
        f.send({ type: 'stt', event: { type: 'end-of-turn' } });
      }
      await f.wait(20);
    }
    expect(f.controller.stats.predictions).toEqual([0.1]);
    expect(f.controller.stats.rechecks).toEqual([0.9]);
    expect(f.controller.stats.released).toBe(1);
    // Released by the second reading, 500 ms into the hold, instead of after 2.5 s.
    expect(stoppedAt! - 1100).toBeLessThan(1500);
    expect(model.requests[1]!.audio!.length).toBeGreaterThan(model.requests[0]!.audio!.length);
  });

  it('ends questions unread when safety.questions is on', async () => {
    const model = fakeModel(0.1);
    const f = fixture(model, { model: { safety: { questions: true } } });
    f.say('Is it safe to go there now?');
    await f.wait(1000);
    expect(f.stops().map((s) => s.text)).toEqual(['Is it safe to go there now?']);
    expect(model.requests).toEqual([]);
    expect(f.controller.stats.bypassed.question).toBe(1);
  });

  it('turns the safety rules off when asked', async () => {
    const model = fakeModel(0.99);
    const f = fixture(model, { model: { safety: { shortAnswers: false, brokenOff: false } } });
    f.say('Yes.', 300);
    await f.wait(1000);
    expect(model.requests.map((r) => r.text)).toEqual(['Yes.']);
  });

  it('passes an audio model the caller audio from just before the turn, at 16 kHz', async () => {
    const model = fakeModel(0.9, 'audio');
    const f = fixture(model, { model: { preRollMs: 300 } });
    // 2 s of 8 kHz audio before and through the turn, 20 ms frames as the carrier sends them.
    const frame = new Int16Array(160).fill(1000);
    const feed = (ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        f.controller.audio(frame, 8000);
        f.clock.advance(20);
      }
    };
    feed(1000);
    const startedAt = f.clock.now();
    f.send({ type: 'vad.start' });
    feed(800);
    f.send({ type: 'vad.stop' });
    // Scribe's final for the commit.
    f.send({
      type: 'stt',
      event: {
        type: 'transcript',
        segment: {
          segmentId: '0',
          revision: 1,
          text: 'Hello there, how are you?',
          stability: 'final',
        },
      },
    });
    f.send({ type: 'stt', event: { type: 'end-of-turn' } });
    await f.wait(500);
    const audio = model.requests[0]!.audio!;
    // From 300 ms before the turn's start to the last frame (pushed 20 ms before the VAD stop).
    expect(audio.length).toBe((300 + 800 - 20) * 16);
    expect(startedAt).toBe(1000);
    expect(f.stops().map((s) => s.text)).toEqual(['Hello there, how are you?']);
  });

  it('ends a turn unread when an audio model has no audio, or the language is not covered', async () => {
    const audioModel = fakeModel(0.1, 'audio');
    const a = fixture(audioModel);
    a.say('Book me a table.');
    await a.wait(1500);
    expect(a.stops().map((s) => s.text)).toEqual(['Book me a table.']);
    expect(a.controller.stats.bypassed.noAudio).toBe(1);
    const tamil = fixture(fakeModel(0.1), {}, 'ta-IN');
    tamil.say('Naan oru kelvi ketkanum.');
    await tamil.wait(1500);
    expect(tamil.stops()).toHaveLength(1);
    expect(tamil.controller.stats.bypassed.language).toBe(1);
  });

  it('does not wait on a slow model past timeoutMs, nor on one that fails', async () => {
    const slow: EndOfTurnModel = {
      name: 'slow',
      input: 'text',
      threshold: () => 0.5,
      predict: () => new Promise(() => {}),
    };
    const f = fixture(slow, { model: { timeoutMs: 400 } });
    f.say('Is it cold in Vienna in December?');
    f.clock.advance(1000);
    expect(f.stops()).toHaveLength(1);
    expect(f.controller.stats.timeouts).toBe(1);
    const failing: EndOfTurnModel = { ...slow, predict: () => Promise.reject(new Error('boom')) };
    const g = fixture(failing);
    g.say('Is it cold in Vienna in December?');
    await g.wait(1000);
    expect(g.stops()).toHaveLength(1);
    expect(g.controller.stats.failures).toBe(1);
  });

  it('ends held words before digits keyed in the hold', async () => {
    const f = fixture(fakeModel(0.1));
    f.say('My booking number is');
    await f.wait(1000);
    for (const digit of ['4', '2', '#']) f.send({ type: 'dtmf', digit });
    await f.wait(100);
    const ends = f.decisions.flatMap((d) => (d.type === 'turn.stopped' ? [d] : []));
    expect(ends.map((d) => d.input)).toEqual([
      { kind: 'speech', text: 'My booking number is', segments: 1 },
      { kind: 'dtmf', digits: '42' },
    ]);
    const started = f.decisions.flatMap((d) => (d.type === 'turn.started' ? [d.turnId] : []));
    expect(new Set(started).size).toBe(started.length);
    expect(ends.map((d) => d.turnId)).toEqual(started);
  });

  it('loads the model once for every session of a model detector plugin', async () => {
    let loads = 0;
    const plugin = modelTurnDetectorPlugin(
      { id: '@winsendotai/ovo-turn-detector-test-model', provider: 'test' },
      async () => {
        loads++;
        return fakeModel(1);
      },
    );
    expect((plugin.manifest as { kind?: string }).kind).toBe('turn-detector');
    expect(plugin.manifest.id).toBe('@winsendotai/ovo-turn-detector-test-model');
    expect(loads).toBe(0);
  });
});
