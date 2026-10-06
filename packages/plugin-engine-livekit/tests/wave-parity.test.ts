import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MULAW_8K,
  type Behavior,
  type EngineEvent,
  type IncrementalTts,
  type SessionInput,
  type TextFilter,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import {
  createFakeCarrier,
  createScriptedStt,
  createScriptedTts,
  installEgressSentinel,
  realClock,
  type EgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { enginePlugin, LIVEKIT_UNSUPPORTED_AGENT_FEATURES } from '../src/plugin.ts';

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

const session = (over: Partial<SessionInput> = {}): SessionInput => ({
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: { name: 'Ravi' },
  maxCallSeconds: 60,
  acknowledgements: [],
  ...over,
});

/** Mu-law audio whose 0x7f bytes would come back as 0xff from a decode and re-encode. */
const NEGATIVE_ZERO = new Uint8Array(400).fill(0x7f);

/** A provider with an incremental session per utterance, recording what it was asked. */
function incrementalTts() {
  const opened: string[][] = [];
  const tts: TextToSpeech = {
    ...createScriptedTts(),
    capabilities: { ...createScriptedTts().capabilities, incrementalText: true },
    async *synthesize() {
      throw new Error('the streaming path must use open()');
    },
    async open(): Promise<IncrementalTts> {
      const pushed: string[] = [];
      opened.push(pushed);
      let flushed!: () => void;
      const done = new Promise<void>((resolve) => (flushed = resolve));
      return {
        push: (text) => void pushed.push(text),
        flush: () => flushed(),
        audio: (async function* () {
          await done;
          yield NEGATIVE_ZERO.slice(0, 160);
          yield NEGATIVE_ZERO.slice(160);
        })(),
        close: async () => undefined,
      };
    },
  };
  return { tts, opened };
}

async function engine(behavior: Behavior, over: Partial<SessionInput> = {}, tts?: TextToSpeech) {
  const { LiveKitEngine } = await import('../src/session-runner.ts');
  const carrier = createFakeCarrier({ format: MULAW_8K });
  const sent: Uint8Array[] = [];
  const send = carrier.duplex.sendAudio.bind(carrier.duplex);
  carrier.duplex.sendAudio = async (bytes) => {
    sent.push(bytes);
    await send(bytes);
  };
  const events: EngineEvent[] = [];
  const filter: TextFilter = {
    id: 'shout',
    order: 1,
    apply: (text) => text.replace('rupees', 'RUPEES'),
  };
  const input = session({ inputEnabled: false, ...over });
  const instance = new LiveKitEngine({
    media: carrier.duplex,
    ...(input.inputEnabled ? { stt: createScriptedStt() } : {}),
    tts: tts ?? createScriptedTts(),
    clock: realClock,
    usage() {},
    behavior,
    session: input,
    textFilters: [filter],
  });
  instance.subscribe((event) => events.push(event));
  return { engine: instance, carrier, sent, events };
}

const until = (check: () => boolean, label: string) =>
  vi.waitFor(() => expect(check(), label).toBe(true), { timeout: 15_000, interval: 20 });

describe('the LiveKit streaming TTS path (TTS-14)', () => {
  it('renders each line in one incremental provider session and sends the provider bytes untouched', async () => {
    const { tts, opened } = incrementalTts();
    let done = false;
    const h = await engine(
      {
        async *respondStream() {
          yield 'Your EMI is five thousand rupees. Please pay today.';
          done = true;
        },
        respond: async () => '',
        isComplete: () => done,
      },
      { mode: 'announcement', initialInput: '' },
      tts,
    );
    try {
      await h.engine.start();
      await expect(h.engine.ended).resolves.toMatchObject({ reason: 'behavior_completed' });
      // One provider session for the whole line: not one request per sentence.
      expect(opened).toEqual([['Your EMI is five thousand RUPEES. Please pay today.']]);
      const audio = Buffer.concat(h.sent);
      expect(audio.byteLength).toBe(400);
      expect([...new Set(audio)]).toEqual([0x7f]);
    } finally {
      await h.engine.dispose('drain');
    }
  }, 30_000);
});

describe('greet-first, voicemail and silence on LiveKit (Wave 2-4 parity)', () => {
  function agent(
    lines: Partial<Record<string, string>>,
    complete = () => false,
  ): Behavior & {
    asked: Record<string, unknown>[];
  } {
    const asked: Record<string, unknown>[] = [];
    return {
      asked,
      respond: async () => '',
      async *respondStream(input, variables = {}) {
        asked.push({ input, ...variables });
        const line = lines[String(variables.inputEvent ?? 'caller')];
        if (line) yield line;
      },
      speaksFirst: () => true,
      isComplete: complete,
      voicemail: () => 'Please call us back.',
      idleTimeoutMs: () => 300,
    };
  }

  it('speaks the opening first, with no caller input and no turn evidence', async () => {
    const behavior = agent({ opening: 'Hello Ravi.' });
    const h = await engine(behavior, { inputEnabled: false });
    try {
      await h.engine.start();
      await until(() => behavior.asked.length > 0, 'opening turn');
      expect(behavior.asked[0]).toMatchObject({ input: '', inputEvent: 'opening', name: 'Ravi' });
      expect(h.events.some((event) => event.type === 'user.turn')).toBe(false);
    } finally {
      await h.engine.dispose('drain');
    }
  }, 30_000);

  it('holds the opening for the answering-machine verdict, then opens for a person', async () => {
    const behavior = agent({ opening: 'Hello Ravi.' });
    const h = await engine(behavior, { inputEnabled: true, amd: { timeoutMs: 5_000 } });
    try {
      await h.engine.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(behavior.asked).toEqual([]);
      h.carrier.caller.answeredBy('human');
      await until(() => behavior.asked.length > 0, 'opening after the verdict');
      expect(behavior.asked[0]).toMatchObject({ inputEvent: 'opening', answeredBy: 'human' });
    } finally {
      await h.engine.dispose('drain');
    }
  }, 30_000);

  it('leaves the voicemail message on a machine and ends the call as voicemail', async () => {
    const behavior = agent({ opening: 'Hello Ravi.' });
    const h = await engine(behavior, { inputEnabled: true, amd: { timeoutMs: 5_000 } });
    try {
      await h.engine.start();
      h.carrier.caller.answeredBy('machine');
      await expect(h.engine.ended).resolves.toMatchObject({ reason: 'voicemail' });
      expect(behavior.asked).toEqual([]);
      expect(
        h.events.some(
          (event) =>
            event.type === 'agent.transcript' &&
            event.state === 'generated' &&
            event.text === 'Please call us back.',
        ),
      ).toBe(true);
    } finally {
      await h.engine.dispose('drain');
    }
  }, 30_000);

  it('runs idle turns on caller silence and ends a final one as caller_idle', async () => {
    let silences = 0;
    const behavior = agent(
      { opening: 'Hello Ravi.', idle: 'Hello? Are you there?' },
      () => silences >= 2,
    );
    const respond = behavior.respondStream!.bind(behavior);
    behavior.respondStream = async function* (input, variables = {}) {
      if (variables.inputEvent === 'idle') silences += 1;
      yield* respond(input, variables);
    };
    const h = await engine(behavior, { inputEnabled: true });
    try {
      await h.engine.start();
      await expect(h.engine.ended).resolves.toMatchObject({ reason: 'caller_idle' });
      expect(behavior.asked.map((entry) => entry.inputEvent)).toEqual(['opening', 'idle', 'idle']);
    } finally {
      await h.engine.dispose('drain');
    }
  }, 30_000);

  it('ends a transfer as transferred, so the host hands the leg on (AGT-15)', async () => {
    let done = false;
    const h = await engine(
      {
        respond: async () => '',
        async *respondStream() {
          done = true;
          yield 'Connecting you now.';
        },
        isComplete: () => done,
        completionReason: () => 'transfer:flow:human',
      },
      { mode: 'announcement', initialInput: '' },
    );
    try {
      await h.engine.start();
      await expect(h.engine.ended).resolves.toMatchObject({
        reason: 'transferred',
        outcome: 'transferred',
      });
    } finally {
      await h.engine.dispose('drain');
    }
  }, 30_000);
});

describe('what LiveKit still does not do', () => {
  it('declares the agent settings it ignores for the host compat check', () => {
    const capabilities = (enginePlugin.manifest as { capabilities?: unknown }).capabilities as {
      unsupportedAgentFeatures: typeof LIVEKIT_UNSUPPORTED_AGENT_FEATURES;
    };
    expect(capabilities.unsupportedAgentFeatures.map((feature) => feature.path)).toEqual([
      'speechCache.enabled',
      'voice.turnDetector.config.filler',
    ]);
  });
});
