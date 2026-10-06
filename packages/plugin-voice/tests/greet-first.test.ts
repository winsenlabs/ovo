import { describe, expect, it } from 'vitest';
import {
  MULAW_8K,
  type Behavior,
  type EngineEvent,
  type SessionInput,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { FakeClock, flushMicrotasks } from '../../conformance/src/drivers/fake-clock.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

/** An STT whose handshake completes only when the test says so, like a slow provider Begin. */
function slowStt() {
  let connect!: () => void;
  const connected = new Promise<void>((resolve) => (connect = resolve));
  const stt: SpeechToText = {
    capabilities: {
      inputFormats: [MULAW_8K],
      languages: ['en-IN'],
      interim: true,
      wordTimestamps: false,
      turnSignals: ['end-of-turn'],
      forceEndpoint: false,
    },
    async start() {
      await connected;
      return { async write() {}, async finish() {}, async cancel() {} };
    },
  };
  return { stt, connect };
}

function harness(behavior: Behavior, session: Partial<SessionInput> = {}) {
  const clock = new FakeClock();
  const carrier = createFakeCarrier({ clock });
  const spoken: string[] = [];
  const { stt, connect } = slowStt();
  const engine = new NativeVoiceSessionEngine({
    clock,
    media: carrier.duplex,
    behavior,
    scheduler: new BoundedSpeechScheduler({
      async play(segment) {
        spoken.push(segment.text);
        return { state: 'completed', evidence: 'confirmed' };
      },
      async interrupt() {},
    }),
    stt,
    session: {
      mode: 'agent',
      language: 'en-IN',
      inputEnabled: true,
      variables: { name: 'Ravi' },
      maxCallSeconds: 600,
      acknowledgements: [],
      ...session,
    },
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  const started = engine.start();
  return { clock, carrier, engine, spoken, events, started, connect };
}

/** A speak-first behaviour that records what each turn was asked. */
function greeter(extra: Partial<Behavior> = {}) {
  const asked: Record<string, unknown>[] = [];
  const behavior: Behavior = {
    respond: async () => '',
    async *respondStream(_input, variables = {}) {
      asked.push(variables);
      if (variables.inputEvent === 'opening') yield `Hello ${String(variables.name)}.`;
    },
    speaksFirst: () => true,
    ...extra,
  };
  return { behavior, asked };
}

describe('greet-first (LAT-2)', () => {
  it('speaks the opening while the STT handshake is still in progress', async () => {
    const { behavior, asked } = greeter();
    const { spoken, started, connect, engine } = harness(behavior);
    await expect.poll(() => spoken).toEqual(['Hello Ravi.']);
    expect(asked[0]).toMatchObject({ inputEvent: 'opening', name: 'Ravi' });
    connect();
    await started;
    await engine.dispose('drain');
  });

  it('waits for the caller when the behaviour does not speak first', async () => {
    const { behavior } = greeter({ speaksFirst: () => false });
    const { spoken, started, connect, engine } = harness(behavior);
    connect();
    await started;
    await flushMicrotasks();
    expect(spoken).toEqual([]);
    await engine.dispose('drain');
  });
});

describe('answering-machine gating', () => {
  it('holds the opening until the carrier hears a human', async () => {
    const { behavior, asked } = greeter();
    const { spoken, carrier, connect, started, engine } = harness(behavior, {
      amd: { timeoutMs: 4000 },
    });
    connect();
    await started;
    await flushMicrotasks();
    expect(spoken).toEqual([]);
    carrier.caller.answeredBy('human');
    await expect.poll(() => spoken).toEqual(['Hello Ravi.']);
    expect(asked[0]).toMatchObject({ inputEvent: 'opening', answeredBy: 'human' });
    await engine.dispose('drain');
  });

  it('opens anyway once the verdict is late', async () => {
    const { behavior } = greeter();
    const { spoken, clock, connect, started, engine } = harness(behavior, {
      amd: { timeoutMs: 4000 },
    });
    connect();
    await started;
    await clock.advanceAsync(3999);
    expect(spoken).toEqual([]);
    await clock.advanceAsync(1);
    await expect.poll(() => spoken).toEqual(['Hello Ravi.']);
    await engine.dispose('drain');
  });

  it('leaves the voicemail message instead of the opening and ends as voicemail', async () => {
    const { behavior } = greeter({
      voicemail: (vars) => `Please call back, ${String(vars.name)}.`,
    });
    const { spoken, carrier, connect, started, engine, events } = harness(behavior, {
      amd: { timeoutMs: 4000 },
    });
    connect();
    await started;
    carrier.caller.answeredBy('machine');
    const outcome = await engine.ended;
    expect(spoken).toEqual(['Please call back, Ravi.']);
    expect(outcome).toEqual({ reason: 'voicemail', outcome: 'voicemail' });
    expect(events.at(-1)).toEqual({
      type: 'end',
      reason: 'voicemail',
      detail: 'voicemail:message',
    });
  });

  it('cuts a late machine off mid-opening and hangs up', async () => {
    const { behavior } = greeter({ voicemail: () => '' });
    const { spoken, carrier, clock, connect, started, engine, events } = harness(behavior, {
      amd: { timeoutMs: 1000 },
    });
    connect();
    await started;
    await clock.advanceAsync(1000);
    await expect.poll(() => spoken).toEqual(['Hello Ravi.']);
    carrier.caller.answeredBy('machine');
    expect(await engine.ended).toEqual({ reason: 'voicemail', outcome: 'voicemail' });
    expect(events.at(-1)).toMatchObject({ detail: 'voicemail:hangup' });
  });

  it('plays a held opening when the behaviour leaves a machine alone', async () => {
    const { behavior, asked } = greeter({ voicemail: () => undefined });
    const { spoken, carrier, connect, started, engine, events } = harness(behavior, {
      amd: { timeoutMs: 4000 },
    });
    connect();
    await started;
    carrier.caller.answeredBy('machine');
    await expect.poll(() => spoken).toEqual(['Hello Ravi.']);
    expect(asked[0]).toMatchObject({ inputEvent: 'opening', answeredBy: 'machine' });
    expect(events.some((event) => event.type === 'end')).toBe(false);
    await engine.dispose('drain');
  });

  it('hangs up when the voicemail message cannot be rendered', async () => {
    const { behavior } = greeter({
      voicemail: () => {
        throw new Error('Missing announcement variable: name');
      },
    });
    const { spoken, carrier, connect, started, engine, events } = harness(behavior, {
      amd: { timeoutMs: 4000 },
    });
    connect();
    await started;
    carrier.caller.answeredBy('machine');
    expect(await engine.ended).toEqual({ reason: 'voicemail', outcome: 'voicemail' });
    expect(spoken).toEqual([]);
    expect(events.at(-1)).toMatchObject({ detail: 'voicemail:message-failed' });
  });

  it('only records a machine for a behaviour that does not handle voicemail', async () => {
    const { behavior } = greeter({ speaksFirst: () => false });
    const { carrier, connect, started, engine, events } = harness(behavior);
    connect();
    await started;
    carrier.caller.answeredBy('machine');
    await flushMicrotasks();
    expect(events).toContainEqual({ type: 'voicemail', result: 'machine' });
    expect(events.some((event) => event.type === 'end')).toBe(false);
    await engine.dispose('drain');
  });
});

describe('a behaviour that ends the call (AGT-3)', () => {
  it('ends completed after the goodbye plays, recording why', async () => {
    let done = false;
    const behavior: Behavior = {
      respond: async () => '',
      async *respondStream(_input, variables = {}) {
        if (variables.inputEvent === 'opening') {
          done = true;
          yield 'Goodbye.';
        }
      },
      speaksFirst: () => true,
      isComplete: () => done,
      completionReason: () => 'decision:intent=bye',
    };
    const { connect, started, engine, events, spoken } = harness(behavior);
    connect();
    await started;
    expect(await engine.ended).toEqual({ reason: 'behavior_completed', outcome: 'completed' });
    expect(spoken).toEqual(['Goodbye.']);
    expect(events.at(-1)).toEqual({
      type: 'end',
      reason: 'behavior_completed',
      detail: 'decision:intent=bye',
    });
  });
});
