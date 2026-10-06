import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import { dialRequestV2 } from '../src/dial-request.ts';
import { WorkerMediaLink } from '../src/worker-media-server.ts';
import { mediaRuntimeFixture, mediaSessionOpen } from './media-runtime-fixtures.ts';
import {
  answeringMachineFor,
  AnsweredByVerdicts,
  watchAnsweredBy,
} from '../src/answering-machine.ts';

const greeter = AgentConfig.parse({
  name: 'Collections',
  mode: 'agent',
  opening: { lines: ['Hello.'] },
});
const asyncAmd = { control: { amd: 'async' } } as const;

describe('answeringMachineFor', () => {
  it('holds an outbound greet-first agent for the verdict', () => {
    expect(answeringMachineFor(greeter, { kind: 'outbound' }, asyncAmd)).toEqual({
      timeoutMs: 4000,
    });
  });

  it('never holds an inbound call', () => {
    expect(answeringMachineFor(greeter, { kind: 'inbound_call' }, asyncAmd)).toBeUndefined();
  });

  it('never holds on a carrier that cannot detect a machine', () => {
    expect(answeringMachineFor(greeter, {}, { control: { amd: 'none' } })).toBeUndefined();
  });

  it('never holds on a carrier that declares no control capabilities', () => {
    expect(answeringMachineFor(greeter, {}, {})).toBeUndefined();
  });

  it('follows an authored policy, including turning detection off', () => {
    const authored = AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      voicemail: { timeoutMs: 2500 },
    });
    expect(answeringMachineFor(authored, {}, asyncAmd)).toEqual({ timeoutMs: 2500 });
    const off = AgentConfig.parse({ ...greeter, voicemail: { detect: false } });
    expect(answeringMachineFor(off, {}, asyncAmd)).toBeUndefined();
  });

  it('leaves an agent that waits for the caller, and every other mode, alone', () => {
    expect(
      answeringMachineFor(AgentConfig.parse({ name: 'A', mode: 'agent' }), {}, asyncAmd),
    ).toBeUndefined();
    expect(
      answeringMachineFor(
        AgentConfig.parse({ name: 'A', mode: 'announcement', message: 'Hi.' }),
        {},
        asyncAmd,
      ),
    ).toBeUndefined();
  });
});

describe('AnsweredByVerdicts', () => {
  it('keeps the first verdict and replays it to a late subscriber', async () => {
    const verdicts = new AnsweredByVerdicts();
    const early = vi.fn();
    verdicts.subscribe(early);
    verdicts.deliver('human');
    verdicts.deliver('machine');
    expect(early.mock.calls).toEqual([['human']]);
    const late = vi.fn();
    verdicts.subscribe(late);
    await Promise.resolve();
    expect(late.mock.calls).toEqual([['human']]);
  });
});

describe('watchAnsweredBy', () => {
  const route = { sessionId: 's-1', organizationId: 'org' };

  it('delivers the recorded verdict and stops reading', async () => {
    const rows: { answered_by: string }[][] = [[], [], [{ answered_by: 'machine' }]];
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
      rows: rows.shift() ?? [],
    }));
    const deliver = vi.fn();
    const stop = watchAnsweredBy({ pool: { query }, route, deliver, intervalMs: 1 });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith('machine'));
    const reads = query.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query.mock.calls.length).toBe(reads);
    expect(query.mock.calls[0]![1]).toEqual(['s-1', 'org']);
    stop();
  });

  it('stops when the session ends without a verdict', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const stop = watchAnsweredBy({ pool: { query }, route, deliver: vi.fn(), intervalMs: 1 });
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    stop();
    const reads = query.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query.mock.calls.length).toBeLessThanOrEqual(reads + 1);
  });

  it('reads quickly only while the opening may be waiting on the verdict', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async () => ({ rows: [] }));
      const stop = watchAnsweredBy({
        pool: { query },
        route,
        deliver: vi.fn(),
        intervalMs: 100,
        fastForMs: 1_000,
        slowIntervalMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const fast = query.mock.calls.length;
      expect(fast).toBeGreaterThanOrEqual(10);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(query.mock.calls.length - fast).toBeLessThanOrEqual(4);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reading through a failed read', async () => {
    let calls = 0;
    const query = vi.fn(async () => {
      if (calls++ === 0) throw new Error('connection reset');
      return { rows: [{ answered_by: 'human' }] };
    });
    const deliver = vi.fn();
    watchAnsweredBy({ pool: { query }, route, deliver, intervalMs: 1 });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith('human'));
  });
});

describe('the dial request', () => {
  const selected = (config: AgentConfig, amd: 'async' | 'none' = 'async') =>
    ({
      release: { config },
      carrier: {
        carrierId: 'twilio',
        bindingId: 'env',
        capabilities: {
          control: { streamParams: 'at-dial', amd },
          media: { formats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }] },
        },
      },
      ports: {
        callbackUrl: (_c: string, _b: string, purpose: string) => `https://x.test/${purpose}`,
        mediaUrl: () => 'wss://x.test/media',
      },
    }) as never;
  const dial = (config: AgentConfig, payload: Record<string, unknown> = {}, amd?: 'none') =>
    dialRequestV2({
      job: { id: 'job-1', workspaceId: 'w', ownerEpoch: 1, payload },
      payload: { to: '+14155550100', from: '+14155550101', ...payload },
      route: { sessionId: 'session-1' },
      token: 'token',
      selected: selected(config, amd),
    });

  it('asks the carrier to detect a machine exactly when the session will wait for it', () => {
    expect(dial(greeter).amd).toEqual({ mode: 'detect' });
    expect(dial(AgentConfig.parse({ name: 'A', mode: 'agent' })).amd).toBeUndefined();
    expect(dial(greeter, {}, 'none').amd).toBeUndefined();
  });
});

describe('the worker media link', () => {
  function link() {
    const gateway = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (_value: string, callback?: () => void) => callback?.(),
      close: vi.fn(),
    });
    return new WorkerMediaLink(
      mediaSessionOpen(mediaRuntimeFixture().route),
      gateway as unknown as WebSocket,
    );
  }

  it('hears the verdict before the session is activated, once, and replays it', async () => {
    const media = link();
    const early = vi.fn();
    media.onAnsweredBy(early);
    media.receive({ type: 'call.answered-by', value: 'human' });
    media.receive({ type: 'call.answered-by', value: 'machine' });
    // Caller audio is still held for activation; the verdict is not.
    expect(early.mock.calls).toEqual([['human']]);
    const late = vi.fn();
    media.onAnsweredBy(late);
    await Promise.resolve();
    expect(late.mock.calls).toEqual([['human']]);
  });
});
