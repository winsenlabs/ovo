import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MULAW_8K,
  type SessionInput,
  type SpeechToText,
  type SttEvent,
  type SttSession,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { VoiceIngress } from '../src/engine/ingress.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

const session: SessionInput = {
  mode: 'faq',
  language: 'en-US',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};
const capabilities = {
  inputFormats: [MULAW_8K],
  languages: ['en-US'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: true,
} as const;

class ProviderDrop extends Error {
  constructor(
    readonly code: number,
    readonly retryable: boolean,
  ) {
    super(`provider closed (${code})`);
  }
}

interface ScriptedSession {
  writes: number[];
  emit(event: SttEvent): void;
  drop(error: Error): void;
}

/** Each start() opens a scripted session; a dropped one throws its error from the next write. */
function scriptedStt(refusals: Error[] = []) {
  const sessions: ScriptedSession[] = [];
  const stt: SpeechToText = {
    capabilities,
    async start(input) {
      const refusal = refusals.shift();
      if (refusal) throw refusal;
      let failure: Error | undefined;
      const scripted: ScriptedSession = {
        writes: [],
        emit: (event) => input.onEvent(event),
        drop: (error) => (failure = error),
      };
      sessions.push(scripted);
      const handle: SttSession = {
        async write(frame) {
          if (failure) throw failure;
          scripted.writes.push(frame[0]!);
        },
        async finish() {},
        async cancel() {},
      };
      return handle;
    },
  };
  return { stt, sessions };
}

function engineFor(stt: SpeechToText, carrier = createFakeCarrier()) {
  const engine = new NativeVoiceSessionEngine({
    behavior: { respond: async () => '' },
    scheduler: new BoundedSpeechScheduler({
      async play() {
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    }),
    media: carrier.duplex,
    stt,
    session,
  });
  return { engine, carrier };
}

function transcript(segmentId: string, revision: number, text: string): SttEvent {
  return {
    type: 'transcript',
    segment: { segmentId, revision, text, stability: 'final' },
  };
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void logged.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

it('takes the ten-second burst a worker replays once STT has connected', async () => {
  // Regression: the worker replays its pre-session buffer synchronously after the session
  // opens. With a 250-frame ingress limit, 500 Twilio frames ended the call as ingress_overflow.
  const { stt, sessions } = scriptedStt();
  const { engine, carrier } = engineFor(stt);
  await engine.start();
  for (let frame = 0; frame < 500; frame++) carrier.caller.audio(new Uint8Array(160));
  expect(engine.ingressStats).toMatchObject({ acceptedFrames: 500, overflows: 0 });
  await vi.waitFor(() => expect(sessions[0]!.writes).toHaveLength(500));
  const ended = vi.fn();
  void engine.ended.then(ended);
  await Promise.resolve();
  expect(ended).not.toHaveBeenCalled();
  await engine.dispose('drain');
});

it('reconnects after a retryable mid-call drop and replays the unfinalized audio', async () => {
  const { stt, sessions } = scriptedStt();
  const carrier = createFakeCarrier();
  const events: VoiceEvent[] = [];
  const reasons: string[] = [];
  const ingress = new VoiceIngress(
    carrier.duplex,
    { maxFrames: 100, maxBytes: 10_000, preSttBufferMs: 10_000 },
    new AbortController().signal,
    (event) => events.push(event),
    (reason) => reasons.push(reason),
  );
  await ingress.connect(stt, 'en-US', () => undefined);
  carrier.caller.audio(Uint8Array.of(1));
  await vi.waitFor(() => expect(sessions[0]!.writes).toEqual([1]));
  sessions[0]!.emit(transcript('0', 1, 'hello'));
  carrier.caller.audio(Uint8Array.of(2));
  await vi.waitFor(() => expect(sessions[0]!.writes).toEqual([1, 2]));
  sessions[0]!.drop(new ProviderDrop(1011, true));
  carrier.caller.audio(Uint8Array.of(3));
  carrier.caller.audio(Uint8Array.of(4));
  // Frame 1 was finalized before the drop; 2 was written but never transcribed, and 3 failed.
  await vi.waitFor(() => expect(sessions[1]?.writes).toEqual([2, 3, 4]));
  sessions[1]!.emit(transcript('0', 1, 'again'));
  // A late event from the dead session is ignored.
  sessions[0]!.emit(transcript('1', 2, 'stale'));
  const segments = events.flatMap((event) =>
    event.type === 'stt' && event.event.type === 'transcript' ? [event.event.segment] : [],
  );
  expect(segments).toMatchObject([
    { segmentId: '0', revision: 1, text: 'hello' },
    { segmentId: '0~r1', revision: 2, text: 'again' },
  ]);
  expect(reasons).toEqual([]);
  expect(logged.some((line) => line.includes('"event":"stt_reconnected"'))).toBe(true);
  await ingress.dispose();
});

it('ends a non-retryable mid-call drop as error:stt with the provider code', async () => {
  const { stt, sessions } = scriptedStt();
  const { engine, carrier } = engineFor(stt);
  await engine.start();
  carrier.caller.audio(Uint8Array.of(1));
  await vi.waitFor(() => expect(sessions[0]!.writes).toEqual([1]));
  sessions[0]!.drop(new ProviderDrop(1008, false));
  carrier.caller.audio(Uint8Array.of(2));
  // Regression: every STT write failure used to end the call as error:ingress_overflow.
  await expect(engine.ended).resolves.toEqual({ reason: 'error:stt:1008', outcome: 'failed' });
  expect(sessions).toHaveLength(1);
});

it('ends the call with the last provider code once reconnect attempts run out', async () => {
  const refusals: Error[] = [];
  const { stt, sessions } = scriptedStt(refusals);
  const { engine, carrier } = engineFor(stt);
  await engine.start();
  // Both reconnect attempts are refused.
  refusals.push(new ProviderDrop(3008, true), new ProviderDrop(1011, true));
  carrier.caller.audio(Uint8Array.of(1));
  await vi.waitFor(() => expect(sessions[0]!.writes).toEqual([1]));
  sessions[0]!.drop(new ProviderDrop(1011, true));
  carrier.caller.audio(Uint8Array.of(2));
  await expect(engine.ended).resolves.toEqual({ reason: 'error:stt:1011', outcome: 'failed' });
  expect(sessions).toHaveLength(1);
});
