import type {
  Clock,
  SpeechCapabilities,
  TurnDecision,
  VoiceEvent,
} from '@winsendotai/ovo-contracts';
import {
  createModelTurnDetector,
  type EndOfTurnModel,
  type EndOfTurnRequest,
} from '../src/index.ts';

/** The model gate's test fixture: fake models, and a model detector driven on a fake clock. */
type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** The conformance kit's FakeClock (a tests/ helper may not import the kit itself). */
export type GateClock = Clock & { advance(ms: number): void };

/** Scribe: finalises only on a host commit. */
export const scribe: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};

/** A model answering `probability(text)` (a constant by default), recording its requests. */
export function fakeModel(
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
export function syncModel(probability: number): EndOfTurnModel {
  return { name: 'sync', input: 'text', threshold: () => 0.5, predict: () => probability };
}

/** A fixture maker: each fixture runs a model detector on a clock of its own from `newClock`. */
export function gateFixture(newClock: () => GateClock) {
  return (model: EndOfTurnModel, row: Record<string, unknown> = {}, language = 'en-IN') => {
    const clock = newClock();
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
    let pending: { text: string; confidence?: number } | undefined;
    const send = (event: WithoutTime<VoiceEvent>) =>
      controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
    const transcript = (text: string, stability: 'interim' | 'final', confidence?: number) =>
      send({
        type: 'stt',
        event: {
          type: 'transcript',
          segment: {
            segmentId: String(segment),
            revision: ++revision,
            text,
            stability,
            ...(confidence === undefined ? {} : { confidence }),
          },
        },
      });
    controller.on((decision) => {
      decisions.push(decision);
      // Scribe answers a host commit with its final 300 ms later.
      if (decision.type === 'force-endpoint' && pending !== undefined) {
        const { text, confidence } = pending;
        pending = undefined;
        clock.setTimeout(() => {
          transcript(text, 'final', confidence);
          send({ type: 'stt', event: { type: 'end-of-turn' } });
          segment++;
        }, 300);
      }
    });
    /** The caller says `text` over `ms` of VAD speech, then goes quiet (the final has `confidence`). */
    const say = (text: string, ms = 800, confidence?: number) => {
      pending = { text, ...(confidence === undefined ? {} : { confidence }) };
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
    const untrusted = () =>
      decisions.flatMap((d) => (d.type === 'turn.stopped' ? [d.untrusted] : []));
    const starts = () => decisions.filter((d) => d.type === 'turn.started').length;
    // Mid-call: the opening has played.
    send({ type: 'bot.started', epoch: 0, kind: 'response' });
    send({ type: 'bot.stopped', epoch: 0, kind: 'response' });
    return { clock, controller, decisions, send, say, wait, stops, starts, untrusted };
  };
}
