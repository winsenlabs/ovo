import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {
  createFakeCarrier,
  createScriptedStt,
  createScriptedTts,
  installEgressSentinel,
  realClock,
  type EgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { SttGate } from '../src/stt-gate.ts';
let sentinel: EgressSentinel;
beforeAll(() => {
  sentinel = installEgressSentinel({ allowLoopback: false });
});
afterAll(() => {
  try {
    expect(sentinel.attempts).toEqual([]);
  } finally {
    sentinel.restore();
  }
});

it('pins the real no-room no-LLM early return and never invokes LiveKit tool execution', async () => {
  const { AgentSession, Agent, initializeLogger, voice } = await import('@livekit/agents');
  const { OvoStt } = await import('../src/stt-adapter.ts');
  const { sessionOptions } = await import('../src/session-options.ts');
  const { OvoTts } = await import('../src/tts-adapter.ts');
  const { CarrierAudioInput } = await import('../src/carrier-input.ts');
  initializeLogger({ pretty: false, level: 'silent' });
  const carrier = createFakeCarrier(),
    stt = createScriptedStt();
  const ports = {
    media: carrier.duplex,
    stt,
    tts: createScriptedTts(),
    behavior: {
      async respond() {
        return '';
      },
    },
    session: {
      mode: 'faq' as const,
      language: 'en-US',
      inputEnabled: true,
      variables: {},
      maxCallSeconds: 60,
      acknowledgements: [],
    },
    clock: realClock,
    usage() {},
  };
  const adapter = new OvoStt(
    ports,
    new SttGate(() => {
      throw new Error('unexpected overflow');
    }),
  );
  const options = sessionOptions(
    adapter,
    new OvoTts(ports, () => {
      throw new Error('no synthesis expected');
    }),
    2,
  );
  const session = new AgentSession(options);
  const turns: string[] = [];
  const tools = vi.fn();
  class NoReplyAgent extends Agent {
    constructor() {
      super({ instructions: 'OVO owns replies.' });
    }
    override async onUserTurnCompleted(
      _ctx: unknown,
      message: { textContent: string | undefined },
    ) {
      turns.push(message.textContent ?? '');
    }
  }
  const input = new CarrierAudioInput(carrier.duplex, () => {});
  session.input.audio = input;
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, tools);
  try {
    await session.start({ agent: new NoReplyAgent() });
    (await stt.session()).say('one real turn');
    await vi.waitFor(() => expect(turns).toEqual(['one real turn']), { timeout: 10000 });
    expect(session.llm).toBeUndefined();
    expect(session.tools).toEqual([]);
    expect(ports.tts.texts).toEqual([]);
    expect(tools).not.toHaveBeenCalled();
  } finally {
    adapter.stop();
    await input.close();
    await session.close();
  }
}, 60000);

it('pins say() refusing an absent TTS provider', async () => {
  const { AgentSession, Agent, initializeLogger, voice } = await import('@livekit/agents');
  initializeLogger({ pretty: false, level: 'silent' });
  const session = new AgentSession({
    vad: null,
    turnHandling: { turnDetection: 'stt', preemptiveGeneration: { enabled: false } },
    aecWarmupDuration: null,
    userAwayTimeout: null,
  });
  class Sink extends voice.AudioOutput {
    clearBuffer() {}
  }
  session.output.audio = new Sink(8000);
  try {
    await session.start({ agent: new Agent({ instructions: 'No TTS installed.' }) });
    expect(() => session.say('unsafe')).toThrow(/TTS/i);
  } finally {
    await session.close();
  }
}, 60000);

it('buffers provider events until release, discards disclosure speech, and fails closed on overflow', () => {
  const delivered = vi.fn(),
    overflow = vi.fn();
  const gate = new SttGate(overflow);
  gate.set('buffer');
  gate.accept({ type: 'end-of-turn' }, delivered);
  expect(delivered).not.toHaveBeenCalled();
  gate.set('open');
  expect(delivered).toHaveBeenCalledTimes(1);
  gate.set('discard');
  gate.accept({ type: 'end-of-turn' }, delivered);
  gate.set('open');
  expect(delivered).toHaveBeenCalledTimes(1);
  gate.set('buffer');
  for (let i = 0; i < 257; i++) gate.accept({ type: 'speech-start' }, delivered);
  expect(overflow).toHaveBeenCalledTimes(1);
  gate.set('open');
  expect(delivered).toHaveBeenCalledTimes(1);
});
