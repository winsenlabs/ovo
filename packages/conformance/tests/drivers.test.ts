import { readFileSync } from 'node:fs';
import net, { connect as namedConnect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createFixtureNet, createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { compose } from '@winsendotai/ovo-runtime';
import { MULAW_8K, type TurnDecision } from '@winsendotai/ovo-contracts';
import {
  EgressBlockedError,
  FakeClock,
  FIXTURE_PLUGIN_IDS,
  connectRawWebSocket,
  createFakeCarrier,
  createFakeCarrierHostPorts,
  fakeTurnDetector,
  fixtureInboundFrame,
  fixtureProviderModule,
  fixtureSerializer,
  installEgressSentinel,
  loopbackNetOptions,
  parseJsonlFixture,
  startLoopbackServer,
  withEgressSentinel,
} from '../src/drivers.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every module the drivers entry reaches through static relative imports. */
function importClosure(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers: string[] = [];
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0]!)
      )
        specifiers.push((node.arguments[0] as ts.StringLiteral).text);
      ts.forEachChild(node, walk);
    };
    walk(source);
    seen.set(file, specifiers);
    for (const specifier of specifiers)
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
  };
  visit(entry);
  return seen;
}

describe('@winsendotai/ovo-conformance/drivers', () => {
  it('never imports vitest, directly or transitively', () => {
    const closure = importClosure(resolve(SRC, 'drivers.ts'));
    const offenders = [...closure].filter(([, specs]) =>
      specs.some((s) => s === 'vitest' || s.startsWith('vitest/') || s.startsWith('@vitest/')),
    );
    expect(offenders.map(([file]) => file)).toEqual([]);
    expect([...closure.keys()].some((file) => file.endsWith('describe.ts'))).toBe(false);
    expect(closure.size).toBeGreaterThan(10);
  });
});

describe('FakeClock', () => {
  it('fires timers in due order, including ones scheduled while advancing', () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 20);
    clock.setTimeout(() => {
      fired.push('a');
      clock.setTimeout(() => fired.push('c'), 5);
    }, 10);
    const cancel = clock.setTimeout(() => fired.push('never'), 15);
    cancel();
    clock.advance(30);
    expect(fired).toEqual(['a', 'c', 'b']);
    expect(clock.now()).toBe(30);
  });
});

describe('egress sentinel', () => {
  it('blocks fetch, WebSocket and socket connects, deletes LIVEKIT_* and restores everything', async () => {
    process.env.LIVEKIT_URL = 'wss://example.livekit.cloud';
    const originalFetch = globalThis.fetch;
    const sentinel = installEgressSentinel();
    try {
      expect(process.env.LIVEKIT_URL).toBeUndefined();
      await expect(fetch('https://example.com')).rejects.toBeInstanceOf(EgressBlockedError);
      expect(() => new WebSocket('wss://example.com')).toThrow(EgressBlockedError);
      expect(() => net.connect({ host: '93.184.215.14', port: 443 })).toThrow(EgressBlockedError);
      expect(() => namedConnect({ host: '93.184.215.14', port: 443 })).toThrow(EgressBlockedError);
      expect(sentinel.attempts).toHaveLength(4);
    } finally {
      sentinel.restore();
    }
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.LIVEKIT_URL).toBe('wss://example.livekit.cloud');
    delete process.env.LIVEKIT_URL;
  });
});

describe('fake carrier driver', () => {
  it('drains audio in real time, echoes marks, and flushes pending marks on clear', async () => {
    const carrier = createFakeCarrier({ clearFlushesMarkers: true });
    const played: string[] = [];
    let cleared = 0;
    carrier.duplex.onPlayed((name) => played.push(name));
    carrier.duplex.onCleared(() => (cleared += 1));
    await carrier.duplex.sendAudio(new Uint8Array(80));
    await carrier.duplex.mark('m1');
    await new Promise((r) => setTimeout(r, 40));
    expect(played).toEqual(['m1']);
    await carrier.duplex.sendAudio(new Uint8Array(8000));
    await carrier.duplex.mark('m2');
    await carrier.duplex.clear();
    await new Promise((r) => setTimeout(r, 5));
    expect(played).toEqual(['m1', 'm2']);
    expect(carrier.log.find((e) => e.type === 'played' && e.name === 'm2')).toMatchObject({
      flushed: true,
    });
    expect(cleared).toBe(1);
  });

  it('drops marks on clear when the carrier does not flush them, and never echoes without evidence', async () => {
    const quiet = createFakeCarrier({ playback: 'manual', clearFlushesMarkers: false });
    const none = createFakeCarrier({ playback: 'manual', playbackEvidence: 'none' });
    const heard: string[] = [];
    quiet.duplex.onPlayed((n) => heard.push(n));
    none.duplex.onPlayed((n) => heard.push(n));
    await quiet.duplex.sendAudio(new Uint8Array(10));
    await quiet.duplex.mark('q');
    await quiet.duplex.clear();
    await none.duplex.mark('n');
    none.drain();
    expect(heard).toEqual([]);
  });

  it('encodes host commands and decodes caller frames through a real codec session', async () => {
    const codec = fixtureSerializer.createSession({});
    codec.decode(
      fixtureInboundFrame({
        type: 'start',
        carrierCallId: 'CA1',
        streamId: 'MZ1',
        format: MULAW_8K,
        routeParams: {},
      }),
    );
    const carrier = createFakeCarrier({
      playback: 'manual',
      codec,
      inbound: (e) => fixtureInboundFrame(e, 'MZ1'),
    });
    const audio: number[] = [];
    carrier.duplex.onAudio((bytes) => audio.push(bytes.byteLength));
    carrier.caller.audio(new Uint8Array([1, 2, 3]));
    await carrier.duplex.sendAudio(new Uint8Array([255]));
    await carrier.duplex.mark('m');
    expect(audio).toEqual([3]);
    expect(carrier.wire.map((frame) => JSON.parse(frame).event)).toEqual(['media', 'mark']);
  });
});

describe('loopback server and raw RFC 6455 client', () => {
  it('delivers masked, fragmented frames with interleaved pings, and answers pings', async () => {
    const received: string[] = [];
    const server = await startLoopbackServer({
      onConnection: (socket) => {
        socket.on('message', (data) => received.push(String(data)));
        socket.ping('hello');
      },
    });
    try {
      const client = await connectRawWebSocket(server.url('/media', 'ws'), {
        ca: loopbackNetOptions().websocketOptions.ca,
      });
      client.sendText('fragmented message payload', { fragments: 4, pingBetween: true });
      expect(await client.next()).toMatchObject({ type: 'ping' });
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual(['fragmented message payload']);
      client.close(1000, 'bye');
      expect((await client.closed).code).toBe(1000);
    } finally {
      await server.close();
    }
  });

  it('lets createNodeNet reach the loopback server with TLS verification on', async () => {
    const server = await startLoopbackServer({
      onRequest: (_req, res) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'),
      onConnection: (socket) => socket.on('message', (data) => socket.send(`echo:${String(data)}`)),
    });
    try {
      const node = createNodeNet(loopbackNetOptions());
      expect(await (await node.fetch(server.url('/x'))).json()).toEqual({ ok: true });
      const socket = node.websocket(server.url('/ws', 'ws'));
      const reply = await new Promise<string>((resolve) => {
        socket.on('open', () => socket.send('ping'));
        socket.on('message', (data) => resolve(String(data)));
      });
      expect(reply).toBe('echo:ping');
      socket.close(1000);
    } finally {
      await server.close();
    }
  });
});

describe('jsonl fixtures, host ports, fixture plugins and the fake turn detector', () => {
  it('validates the fixture header', () => {
    expect(
      parseJsonlFixture(
        '{"source":"https://x.test/doc","retrieved":"2026-09-22","verbatim":[],"unconfirmed":["a"]}\n{"dir":"in","frame":{}}',
      ).lines,
    ).toHaveLength(1);
    expect(() =>
      parseJsonlFixture('{"source":"x","retrieved":"2026-09-22","verbatim":[],"unconfirmed":[]}'),
    ).toThrow(/documentation URL/);
    expect(() =>
      parseJsonlFixture(
        '{"source":"https://x.test","retrieved":"today","verbatim":[],"unconfirmed":[]}',
      ),
    ).toThrow(/ISO date/);
  });

  it('issues per-call url-secrets that verify only for their own request id', () => {
    const host = createFakeCarrierHostPorts();
    const url = new URL(host.callbackUrl('fixture', 'b1', 'status', { requestId: 'dial-1' }));
    const request = {
      method: 'POST' as const,
      externalUrl: `${url.origin}${url.pathname}`,
      query: Object.fromEntries(url.searchParams),
      headers: {},
      rawBody: new Uint8Array(0),
      bindingId: 'b1',
    };
    expect(host.verifyUrlSecret(request, { purpose: 'status', requestId: 'dial-1' })).toBe(true);
    expect(host.verifyUrlSecret(request, { purpose: 'status', requestId: 'dial-2' })).toBe(false);
    expect(host.mediaUrl('fixture', 'b1')).toBe('wss://ovo.example.test/carriers/fixture/b1/media');
  });

  it('composes fixture-kind plugins only with fixtures: true, behind a FixtureNet', async () => {
    const rows = [{ id: FIXTURE_PLUGIN_IDS.stt }];
    await expect(
      compose(rows, fixtureProviderModule.plugins, { scope: 'session' }),
    ).rejects.toThrow(/fixture/i);
    const composition = await withEgressSentinel(() =>
      compose(rows, fixtureProviderModule.plugins, {
        scope: 'session',
        fixtures: true,
        net: createFixtureNet(fixtureProviderModule.fixtures[FIXTURE_PLUGIN_IDS.stt]!),
      }),
    );
    expect(composition.ctx.get('ovo.stt')).toBeDefined();
    await composition.dispose();
  });

  it('exposes controllers that accept injected decisions', () => {
    const factory = fakeTurnDetector();
    const controller = factory.create({
      clock: new FakeClock(),
      language: 'en-US',
      mode: 'faq',
      vad: false,
    });
    const seen: TurnDecision[] = [];
    controller.on((d) => seen.push(d));
    factory.controllers[0]!.emit({ type: 'force-endpoint' });
    expect(seen).toEqual([{ type: 'force-endpoint' }]);
  });
});
