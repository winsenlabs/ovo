import { describe, expect, it } from 'vitest';
import type { NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import {
  createFixtureNet,
  createNodeNet,
  keepalive,
  openProviderSocket,
  readSse,
  sseLines,
  usageOnce,
} from '../src/index.ts';

function stream(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('SSE reader', () => {
  it('splits lines on CRLF, LF and CR, even across chunk boundaries', async () => {
    expect(await collect(sseLines(stream(['a\r', '\nb\nc\rd', '\r\n'])))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('parses events, multi-line data, comments and ids', async () => {
    const events = await collect(
      readSse(
        stream([
          ': keepalive\n',
          'event: speech.audio.delta\ndata: {"a"',
          ':1}\n\n',
          'data: one\ndata: two\nid: 7\n\n',
        ]),
      ),
    );
    expect(events).toEqual([
      { event: 'speech.audio.delta', data: '{"a":1}', id: undefined, retry: undefined },
      { event: 'message', data: 'one\ntwo', id: '7', retry: undefined },
    ]);
  });
});

describe('openProviderSocket', () => {
  const scripts = [
    {
      host: 'stt.example.com',
      source: 'https://docs.example.com',
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'ws-open' as const,
          url: 'wss://stt.example.com/v1',
          headers: { authorization: 'Token k' },
        },
      ],
    },
  ];

  it('opens through the NetPort with headers and an allow-list', async () => {
    const net = createFixtureNet(scripts);
    const socket = await openProviderSocket(
      net,
      'wss://stt.example.com/v1',
      { authorization: 'Token k' },
      ['stt.example.com'],
    );
    expect(socket.readyState).toBe(1);
    expect(() =>
      openProviderSocket(net, 'wss://evil.example.com/v1', {}, ['stt.example.com']),
    ).toThrow(/not allowed/);
    expect(() =>
      openProviderSocket(net, 'ws://stt.example.com/v1', {}, ['stt.example.com']),
    ).toThrow(/wss/);
  });

  it('rejects on the connect deadline and on abort', async () => {
    const never: NetPort = {
      fetch: () => Promise.reject(new Error('unused')),
      websocket: () =>
        ({
          readyState: 0,
          send() {},
          close() {},
          on: () => () => undefined,
        }) as unknown as WebSocketLike,
    };
    await expect(
      openProviderSocket(never, 'wss://stt.example.com/v1', {}, ['stt.example.com'], {
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    const controller = new AbortController();
    const pending = openProviderSocket(never, 'wss://stt.example.com/v1', {}, ['stt.example.com'], {
      signal: controller.signal,
    });
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(pending).rejects.toThrow('stop');
  });

  it('sends keepalives while open and stops on close', () => {
    const sent: unknown[] = [];
    let onClose: () => void = () => undefined;
    const timers: (() => void)[] = [];
    const socket = {
      readyState: 1,
      send: (data: unknown) => sent.push(data),
      close() {},
      on: (event: string, fn: () => void) => {
        if (event === 'close') onClose = fn;
        return () => undefined;
      },
    } as unknown as WebSocketLike;
    const clock = { setTimeout: (fn: () => void) => (timers.push(fn), () => undefined) };
    keepalive(socket, { intervalMs: 5000, message: () => '{"type":"KeepAlive"}', clock });
    timers.shift()!();
    timers.shift()!();
    expect(sent).toEqual(['{"type":"KeepAlive"}', '{"type":"KeepAlive"}']);
    onClose();
    timers.shift()?.();
    expect(sent).toHaveLength(2);
  });
});

describe('createNodeNet and usageOnce', () => {
  it('accepts only https: and wss: URLs without credentials', async () => {
    const net = createNodeNet({ fetch: async () => new Response('ok') });
    await expect(net.fetch('http://api.example.com/')).rejects.toThrow(/https: and wss:/);
    await expect(net.fetch('https://user:pw@api.example.com/')).rejects.toThrow(/credentials/);
    expect(await (await net.fetch('https://api.example.com/')).text()).toBe('ok');
    expect(() => net.websocket('ws://api.example.com/')).toThrow(/https: and wss:/);
  });

  it('emits usage exactly once and requires a requestId', () => {
    const seen: unknown[] = [];
    const once = usageOnce((meter) => seen.push(meter));
    const meter = {
      provider: 'p',
      operation: 'stt' as const,
      unit: 'audio_seconds' as const,
      quantity: '1',
      state: 'estimated' as const,
      requestId: 'r',
      elapsedMs: 0,
    };
    expect(once.emit(meter)).toBe(true);
    expect(once.emit(meter)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(() => usageOnce(() => undefined).emit({ ...meter, requestId: '' })).toThrow(/requestId/);
  });
});
