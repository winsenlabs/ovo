import { MULAW_8K, type NetFixtureScript, type SttEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { createSttReplayNet } from '../../fixture-calls/src/stt-replay-net.ts';
import { planSttReplay } from '../../fixture-calls/src/stt-replay-plan.ts';
import { AssemblyAiStt, assemblyAiUrl } from '../src/provider.ts';
import { AssemblyAiProviderError } from '../src/session.ts';
import { assemblyAiTemplate } from '../src/testing.ts';

const host = 'streaming.assemblyai.com';
const source = 'https://www.assemblyai.com/docs/streaming/message-sequence';
const begin = {
  type: 'Begin',
  id: 'aa-1',
  expires_at: '2026-09-26T00:00:00Z',
  configuration: { model: 'universal-streaming-english' },
};

function script(steps: NetFixtureScript['steps']): NetFixtureScript[] {
  return [{ host, source, retrieved: '2026-09-26', steps }];
}

function open() {
  return {
    expect: 'ws-open' as const,
    url: /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/,
    headers: { authorization: 'fixture-key' },
  };
}

function input(events: SttEvent[], usage: unknown[]) {
  return {
    sessionId: 'aa-test',
    format: MULAW_8K,
    language: 'en',
    signal: new AbortController().signal,
    onEvent: (event: SttEvent) => events.push(event),
    onUsage: (meter: unknown) => usage.push(meter),
  };
}

describe('AssemblyAI documented wire protocol', () => {
  it('holds a second scripted turn until its caller audio is released', async () => {
    const clock = new FakeClock();
    const plan = planSttReplay(assemblyAiTemplate, {
      format: MULAW_8K,
      language: 'en',
      sessionId: 'two-turns',
      turns: [
        { atMs: 0, say: 'first' },
        { atMs: 2000, say: 'second' },
      ],
    });
    const replay = createSttReplayNet(plan, clock);
    const events: SttEvent[] = [];
    const session = await new AssemblyAiStt(replay.port, 'fixture-key', {}, clock).start({
      ...input(events, []),
      sessionId: 'two-turns',
    });
    const finals = () =>
      events.flatMap((event) =>
        event.type === 'transcript' && event.segment.stability === 'final'
          ? [event.segment.text]
          : [],
      );
    replay.release(0);
    await session.write(new Uint8Array(800));
    await clock.advanceAsync(0);
    expect(finals()).toEqual(['first']);
    expect(() => replay.assertComplete()).toThrow();
    replay.release(1);
    await session.write(new Uint8Array(800));
    await clock.advanceAsync(0);
    expect(finals()).toEqual(['first', 'second']);
    await session.finish();
    expect(() => replay.assertComplete()).not.toThrow();
  });

  it('advertises only languages supported by the selected model and rejects an unsupported start', async () => {
    const net = createFixtureNet([]);
    const english = new AssemblyAiStt(net, 'fixture-key');
    const multilingual = new AssemblyAiStt(net, 'fixture-key', {
      model: 'universal-streaming-multilingual',
    });
    const pro = new AssemblyAiStt(net, 'fixture-key', { model: 'universal-3-5-pro' });
    expect(english.capabilities.languages).toEqual(['en']);
    expect(multilingual.capabilities.languages).toEqual(['en', 'es', 'de', 'fr', 'pt', 'it']);
    expect(multilingual.capabilities.languages).not.toContain('hi');
    expect(pro.capabilities.languages).toContain('hi');
    expect(pro.capabilities.languages).not.toContain('ur');
    await expect(english.start({ ...input([], []), language: 'hi-IN' })).rejects.toThrow(
      'does not support hi-IN',
    );
    expect(net.log).toHaveLength(0);
  });

  it('builds the documented model, codec, rate and turn-format query', () => {
    const url = new URL(assemblyAiUrl({ model: 'universal-3-5-pro', region: 'eu' }, MULAW_8K));
    expect(url.host).toBe('streaming.eu.assemblyai.com');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      speech_model: 'universal-3-5-pro',
      sample_rate: '8000',
      encoding: 'pcm_mulaw',
      format_turns: 'false',
    });
  });

  it('keeps 20 ms writes and an oversized caller write within 50–1000 ms provider frames', async () => {
    const net = createFixtureNet(
      script([
        open(),
        { send: JSON.stringify(begin) },
        { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
        { expect: 'ws-send', match: 'json', where: { type: 'ForceEndpoint' } },
        { expect: 'ws-send', match: 'json', where: { type: 'Terminate' } },
        { send: JSON.stringify({ type: 'Termination', session_duration_seconds: 2.5 }) },
        { close: { code: 1000 } },
      ]),
    );
    const events: SttEvent[] = [];
    const usage: unknown[] = [];
    const session = await new AssemblyAiStt(net, 'fixture-key').start(input(events, usage));
    for (let i = 0; i < 9; i += 1) await session.write(new Uint8Array(160));
    await session.write(new Uint8Array(9_600)); // one 1200 ms caller write
    await session.forceEndpoint();
    await session.finish();
    const frames = net.log.filter(
      (entry) => entry.kind === 'ws-out' && entry.data instanceof Uint8Array,
    );
    expect(frames.length).toBeGreaterThan(0);
    const sizes = frames.map((entry) => (entry.data as Uint8Array).byteLength);
    expect(sizes).toEqual([480, 480, 480, 8_000, 1_600]);
    expect(sizes.every((size) => size >= 400 && size <= 8_000)).toBe(true);
    expect(usage).toMatchObject([{ requestId: 'aa-1', quantity: '2.5', state: 'reconciled' }]);
    net.assertComplete();
  });

  it('revises one turn_order for a formatted duplicate and keeps revision monotonic across turns', async () => {
    const net = createFixtureNet(
      script([
        open(),
        { send: JSON.stringify(begin) },
        { expect: 'ws-send', match: 'binary' },
        {
          send: JSON.stringify({
            type: 'Turn',
            turn_order: 0,
            transcript: 'one',
            end_of_turn: true,
            turn_is_formatted: false,
          }),
        },
        {
          send: JSON.stringify({
            type: 'Turn',
            turn_order: 0,
            transcript: 'One.',
            end_of_turn: true,
            turn_is_formatted: true,
          }),
        },
        {
          send: JSON.stringify({
            type: 'Turn',
            turn_order: 1,
            transcript: 'two',
            end_of_turn: true,
            turn_is_formatted: false,
          }),
        },
        { expect: 'ws-send', match: 'json', where: { type: 'Terminate' } },
        { send: JSON.stringify({ type: 'Termination', session_duration_seconds: 1 }) },
        { close: { code: 1000 } },
      ]),
    );
    const events: SttEvent[] = [];
    const session = await new AssemblyAiStt(net, 'fixture-key').start(input(events, []));
    await session.write(new Uint8Array(400));
    await session.finish();
    expect(
      events.filter((event) => event.type === 'transcript').map((event) => event.segment),
    ).toMatchObject([
      { segmentId: '0', revision: 1, text: 'one', stability: 'final', formatted: false },
      { segmentId: '0', revision: 2, text: 'One.', stability: 'final', formatted: true },
      { segmentId: '1', revision: 3, text: 'two', stability: 'final', formatted: false },
    ]);
    expect(events.filter((event) => event.type === 'end-of-turn')).toHaveLength(2);
    net.assertComplete();
  });

  it('rejects a Begin model mismatch before exposing a session and emits estimated usage once', async () => {
    const net = createFixtureNet(
      script([
        open(),
        { send: JSON.stringify({ ...begin, configuration: { model: 'universal-3-5-pro' } }) },
      ]),
    );
    const usage: unknown[] = [];
    await expect(
      new AssemblyAiStt(net, 'fixture-key').start(input([], usage)),
    ).rejects.toMatchObject({
      name: 'AssemblyAiProviderError',
      code: 'model-mismatch',
      retryable: false,
    } satisfies Partial<AssemblyAiProviderError>);
    expect(usage).toMatchObject([{ state: 'estimated', requestId: 'assemblyai:aa-test:1' }]);
    net.assertComplete();
  });

  it.each([
    [1008, false],
    [3005, false],
    [3006, false],
    [3007, false],
    [3008, true],
    [3009, true],
    [1011, true],
    [1006, true],
  ])('maps close code %i to a typed retryable=%s failure', async (code, retryable) => {
    const refusal = script([open(), { close: { code, reason: 'provider refusal' } }]);
    // A retryable refusal during the handshake is retried once before it reaches the host.
    const net = createFixtureNet(retryable ? [...refusal, ...refusal] : refusal);
    const usage: unknown[] = [];
    await expect(
      new AssemblyAiStt(net, 'fixture-key').start(input([], usage)),
    ).rejects.toMatchObject({
      name: 'AssemblyAiProviderError',
      code,
      retryable,
    });
    expect(usage).toMatchObject(
      [1, ...(retryable ? [2] : [])].map((attempt) => ({
        state: 'estimated',
        requestId: `assemblyai:aa-test:${attempt}`,
      })),
    );
    net.assertComplete();
  });
});
