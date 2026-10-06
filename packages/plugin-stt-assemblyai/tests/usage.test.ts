import { MULAW_8K, type NetFixtureScript, type UsageMeter } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssemblyAiStt } from '../src/provider.ts';
import { TERMINATION_GRACE_MS } from '../src/session.ts';
import { terminationSteps } from '../src/testing.ts';

// OPS-18: a hang-up used to close the socket without Terminate, so every call's STT cost was a
// wall-clock estimate instead of the duration AssemblyAI bills.

const begin = JSON.stringify({
  type: 'Begin',
  id: 'aa-usage',
  expires_at: '2026-10-06T00:00:00Z',
  configuration: { model: 'universal-streaming-english' },
});

function socket(steps: NetFixtureScript['steps']): NetFixtureScript {
  return {
    host: 'streaming.assemblyai.com',
    source: 'https://www.assemblyai.com/docs/streaming/message-sequence',
    retrieved: '2026-10-06',
    steps: [{ expect: 'ws-open', url: /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/ }, ...steps],
  };
}

function input(usage: UsageMeter[], signal = new AbortController().signal) {
  return {
    sessionId: 'aa-usage',
    format: MULAW_8K,
    language: 'en-IN',
    signal,
    onEvent: () => undefined,
    onUsage: (meter: UsageMeter) => usage.push(meter),
  };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

describe('AssemblyAI metering on cancel and hang-up (OPS-18)', () => {
  it('sends Terminate on cancel and meters the billed Termination duration', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        socket([
          { send: begin },
          { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
          ...terminationSteps(2.5),
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const session = await new AssemblyAiStt(net, 'fixture-key', {}, clock).start(input(usage));
    await session.write(new Uint8Array(8_000)); // one second of 8 kHz mu-law
    clock.advance(9_000);
    await session.cancel('engine disposed');
    expect(usage).toMatchObject([
      { requestId: 'aa-usage', unit: 'session_seconds', quantity: '2.5', state: 'reconciled' },
    ]);
    expect(net.log.at(-1)?.kind).toBe('ws-close');
    net.assertComplete();
    const line = JSON.parse(logs.find((entry) => entry.includes('"stt_usage"'))!);
    expect(line).toMatchObject({ state: 'reconciled', sessionSeconds: 2.5, audioSeconds: 1 });
  });

  it('asks for Termination when the call hangs up (the session signal aborts)', async () => {
    const net = createFixtureNet([
      socket([
        { send: begin },
        { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
        ...terminationSteps(4),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const hangUp = new AbortController();
    const session = await new AssemblyAiStt(net, 'fixture-key').start(input(usage, hangUp.signal));
    await session.write(new Uint8Array(1_600));
    hangUp.abort(new DOMException('caller_hangup', 'AbortError'));
    await expect(session.write(new Uint8Array(160))).rejects.toThrow();
    await session.cancel('engine disposed');
    expect(usage).toMatchObject([{ quantity: '4', state: 'reconciled' }]);
    net.assertComplete();
  });

  it('meters the wall-clock estimate once the grace passes without a Termination', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        socket([
          { send: begin },
          { expect: 'ws-send', match: 'json', where: { type: 'Terminate' } },
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const session = await new AssemblyAiStt(net, 'fixture-key', {}, clock).start(input(usage));
    clock.advance(3_000);
    const cancelled = session.cancel('engine disposed');
    await clock.advanceAsync(TERMINATION_GRACE_MS - 1);
    expect(usage).toEqual([]);
    await clock.advanceAsync(1);
    await cancelled;
    expect(usage).toMatchObject([
      { quantity: String(3 + TERMINATION_GRACE_MS / 1000), state: 'estimated' },
    ]);
    expect(net.log.at(-1)?.kind).toBe('ws-close');
    net.assertComplete();
  });

  it('closes at once without Terminate when Begin never arrived', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet([socket([])], { clock });
    const usage: UsageMeter[] = [];
    const hangUp = new AbortController();
    const starting = new AssemblyAiStt(net, 'fixture-key', {}, clock).start(
      input(usage, hangUp.signal),
    );
    await clock.advanceAsync(100);
    hangUp.abort();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(usage).toMatchObject([{ requestId: 'assemblyai:aa-usage:1', state: 'estimated' }]);
    net.assertComplete();
  });
});
