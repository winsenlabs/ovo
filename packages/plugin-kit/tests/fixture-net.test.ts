import { describe, expect, it } from 'vitest';
import type { Clock } from '@winsendotai/ovo-contracts';
import { FixtureMismatchError, createFixtureNet, type FixtureScript } from '../src/index.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => (timers = timers.filter((t) => t !== timer)) && undefined;
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      due.forEach((t) => t.fn());
    },
  };
}

const script = (steps: FixtureScript['steps'], host = 'api.example.com'): FixtureScript => ({
  host,
  source: 'https://docs.example.com/api',
  retrieved: '2026-09-22',
  steps,
});

describe('FixtureNet over HTTP', () => {
  it('replays a matching request and rejects everything else with FixtureMismatchError', async () => {
    const net = createFixtureNet([
      script([
        {
          expect: 'http',
          method: 'POST',
          url: 'https://api.example.com/v1/calls',
          body: 'form',
          where: { To: '+15550100', Event: ['initiated', 'ringing'] },
          reply: { status: 201, headers: { 'x-request-id': 'r1' }, body: '{"id":"CA1"}' },
        },
      ]),
    ]);
    const response = await net.fetch('https://api.example.com/v1/calls', {
      method: 'POST',
      body: new URLSearchParams([
        ['To', '+15550100'],
        ['Event', 'initiated'],
        ['Event', 'ringing'],
      ]),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('r1');
    expect(await response.json()).toEqual({ id: 'CA1' });
    const error = await net
      .fetch('https://api.example.com/v1/calls', { method: 'POST' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FixtureMismatchError);
    expect((error as Error).message).toContain('end of script');
    expect(net.mismatches).toHaveLength(1);
    await expect(net.fetch('http://api.example.com/v1/calls')).rejects.toThrow(/https/);
  });

  it('matches JSON bodies with where, streams chunked replies and names the expected step', async () => {
    const net = createFixtureNet([
      script([
        {
          expect: 'http',
          method: 'POST',
          url: /\/v1\/speech$/,
          body: 'json',
          where: { 'voice.id': 'alloy', text: /hello/ },
          reply: { status: 200, chunks: ['ab', { base64: Buffer.from('c').toString('base64') }] },
        },
      ]),
    ]);
    const mismatch = await net
      .fetch('https://api.example.com/v1/speech', {
        method: 'POST',
        body: JSON.stringify({ voice: { id: 'x' }, text: 'hello' }),
      })
      .catch((e: unknown) => e);
    expect((mismatch as Error).message).toMatch(/step #0 http POST/);
    const response = await net.fetch('https://api.example.com/v1/speech', {
      method: 'POST',
      body: JSON.stringify({ voice: { id: 'alloy' }, text: 'hello there' }),
    });
    expect(await response.text()).toBe('abc');
    expect(net.pending()).toEqual([]);
  });

  it('waits delay steps on the injected clock before replying', async () => {
    const clock = manualClock();
    const net = createFixtureNet(
      [
        script([
          { delayMs: 500 },
          {
            expect: 'http',
            method: 'GET',
            url: 'https://api.example.com/x',
            reply: { status: 204 },
          },
        ]),
      ],
      { clock },
    );
    let settled = false;
    const pending = net.fetch('https://api.example.com/x').then((r) => {
      settled = true;
      return r;
    });
    await tick();
    expect(settled).toBe(false);
    clock.advance(500);
    expect((await pending).status).toBe(204);
  });

  it('does not consume or log a scripted request when already aborted', async () => {
    const net = createFixtureNet([
      script([
        { expect: 'http', method: 'GET', url: 'https://api.example.com/x', reply: { status: 204 } },
      ]),
    ]);
    const controller = new AbortController();
    controller.abort(new DOMException('stopped', 'AbortError'));
    await expect(
      net.fetch('https://api.example.com/x', { signal: controller.signal }),
    ).rejects.toThrow('stopped');
    expect(net.log).toEqual([]);
    expect(net.pending()).toHaveLength(1);
    expect((await net.fetch('https://api.example.com/x')).status).toBe(204);
    net.assertComplete();
  });
});

describe('FixtureNet over WebSocket', () => {
  const streaming = () =>
    script(
      [
        {
          expect: 'ws-open',
          url: /^wss:\/\/stt\.example\.com\/listen\?/,
          headers: { authorization: /^Token / },
        },
        { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
        { send: '{"type":"interim","text":"hel"}' },
        { send: { base64: Buffer.from([1, 2]).toString('base64') } },
        { expect: 'ws-send', match: 'json', where: { type: 'Finalize' } },
        { delayMs: 100 },
        { send: '{"type":"final","text":"hello"}' },
        { close: { code: 1000, reason: 'done' } },
      ],
      'stt.example.com',
    );

  it('drives open, streamed audio frames, server sends, delays and close strictly', async () => {
    const clock = manualClock();
    const net = createFixtureNet([streaming()], { clock });
    const socket = net.websocket('wss://stt.example.com/listen?model=x', {
      headers: { Authorization: 'Token k' },
    });
    const received: unknown[] = [];
    let closed: [number, string] | undefined;
    socket.on('message', (data, binary) =>
      received.push(binary ? [...(data as Uint8Array)] : data),
    );
    socket.on('close', (code, reason) => (closed = [code, reason]));
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.send(new Uint8Array(160));
    await tick();
    socket.send(new Uint8Array(160));
    socket.send(new Uint8Array(160));
    socket.send(JSON.stringify({ type: 'Finalize' }));
    await tick();
    expect(received).toEqual(['{"type":"interim","text":"hel"}', [1, 2]]);
    clock.advance(100);
    await tick();
    expect(received.at(-1)).toBe('{"type":"final","text":"hello"}');
    expect(closed).toEqual([1000, 'done']);
    expect(socket.readyState).toBe(3);
    net.assertComplete();
    expect(net.log.filter((e) => e.kind === 'ws-out')).toHaveLength(4);
  });

  it('throws FixtureMismatchError for an unexpected frame and for a bad open', async () => {
    const net = createFixtureNet([streaming()]);
    expect(() => net.websocket('wss://stt.example.com/listen?x=1', { headers: {} })).toThrow(
      FixtureMismatchError,
    );
    const socket = net.websocket('wss://stt.example.com/listen?x=1', {
      headers: { authorization: 'Token k' },
    });
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    expect(() => socket.send('{"type":"KeepAlive"}')).toThrow(/ws-send binary/);
    expect(net.mismatches).toHaveLength(2);
    expect(() => net.assertComplete()).toThrow(/incomplete/);
  });

  it('lets a repeat step accept zero frames when the next ws-send matches', async () => {
    const net = createFixtureNet([
      script(
        [
          { expect: 'ws-open', url: 'wss://stt.example.com/listen' },
          { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
          { expect: 'ws-send', match: 'json', where: { type: 'Finalize' } },
          { send: 'done' },
        ],
        'stt.example.com',
      ),
    ]);
    const socket = net.websocket('wss://stt.example.com/listen');
    const received: unknown[] = [];
    socket.on('message', (data) => received.push(data));
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.send(JSON.stringify({ type: 'Finalize' }));
    await tick();
    expect(received).toEqual(['done']);
    // A frame that matches neither the head nor a background repeat is a mismatch.
    expect(() => socket.send('{"type":"KeepAlive"}')).toThrow(FixtureMismatchError);
  });

  it('treats a client close as consuming a pending server close', async () => {
    const net = createFixtureNet([
      script([
        { expect: 'ws-open', url: 'wss://api.example.com/ws' },
        { close: { code: 1000, reason: 'bye' } },
      ]),
    ]);
    const socket = net.websocket('wss://api.example.com/ws');
    let code = 0;
    socket.on('close', (c) => (code = c));
    socket.close(1000, 'bye');
    await tick();
    expect(code).toBe(1000);
    net.assertComplete();
  });

  it('does not consume a scripted close with the wrong code or reason', async () => {
    const net = createFixtureNet([
      script([
        { expect: 'ws-open', url: 'wss://api.example.com/ws' },
        { close: { code: 1000, reason: 'bye' } },
      ]),
    ]);
    const socket = net.websocket('wss://api.example.com/ws');
    expect(() => socket.close(1001, 'bye')).toThrow(FixtureMismatchError);
    expect(() => socket.close(1000, 'wrong')).toThrow(FixtureMismatchError);
    expect(net.pending()).toHaveLength(1);
    socket.close(1000, 'bye');
    await tick();
    expect(net.mismatches).toHaveLength(2);
  });
});

describe('FixtureNet asserts what a script actually promised', () => {
  const authorized = () =>
    script([
      {
        expect: 'http',
        method: 'POST',
        url: 'https://api.example.com/v1/say',
        headers: { authorization: 'Bearer good', 'content-type': /^application\/json/ },
        reply: { status: 200, body: '{}' },
      },
    ]);

  it('refuses an http call whose headers do not match the step', async () => {
    const net = createFixtureNet([authorized()]);
    const error = await net
      .fetch('https://api.example.com/v1/say', {
        method: 'POST',
        headers: { authorization: 'WRONG', 'content-type': 'application/json' },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FixtureMismatchError);
    expect((error as Error).message).toMatch(/step #0 http POST/);
    expect(net.pending()).toHaveLength(1);
  });

  it('refuses an http call that omits a required header, and accepts the right one', async () => {
    const net = createFixtureNet([authorized()]);
    await expect(
      net.fetch('https://api.example.com/v1/say', { method: 'POST' }),
    ).rejects.toBeInstanceOf(FixtureMismatchError);
    // Header names are case-insensitive on the wire, so the expectation is too.
    const accepting = createFixtureNet([authorized()]);
    const response = await accepting.fetch('https://api.example.com/v1/say', {
      method: 'POST',
      headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json; charset=utf-8' },
    });
    expect(response.status).toBe(200);
    accepting.assertComplete();
  });

  it('reports a request that never happened as a FixtureMismatchError, from close and dispose too', () => {
    const net = createFixtureNet([authorized()]);
    expect(() => net.assertComplete()).toThrow(FixtureMismatchError);
    expect(() => net.close()).toThrow(FixtureMismatchError);
    expect(() => net[Symbol.dispose]()).toThrow(FixtureMismatchError);
    const error =
      net.mismatches[0] ??
      (() => {
        try {
          net.close();
        } catch (e) {
          return e as FixtureMismatchError;
        }
        return undefined;
      })();
    expect((error as FixtureMismatchError).problems.join('\n')).toMatch(/unconsumed step #0 http/);
  });

  it('makes a frame after close a FixtureMismatchError, not a bare Error', async () => {
    const net = createFixtureNet([
      script([{ expect: 'ws-open', url: 'wss://api.example.com/ws' }, { close: { code: 1000 } }]),
    ]);
    const socket = net.websocket('wss://api.example.com/ws');
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.close(1000);
    const error = (() => {
      try {
        socket.send('late');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FixtureMismatchError);
    expect((error as Error).message).toMatch(/closing socket|closed socket/);
    expect(net.mismatches).toHaveLength(1);
  });

  it('reports a client close that leaves the socket script unfinished', async () => {
    const net = createFixtureNet([
      script([
        { expect: 'ws-open', url: 'wss://api.example.com/ws' },
        { expect: 'ws-send', match: 'json', where: { type: 'Finalize' } },
        { send: 'bye' },
      ]),
    ]);
    const socket = net.websocket('wss://api.example.com/ws');
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    const error = (() => {
      try {
        socket.close(1000, 'early');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FixtureMismatchError);
    expect((error as Error).message).toMatch(/ws-send json/);
    expect(net.mismatches).toHaveLength(1);
  });
});
