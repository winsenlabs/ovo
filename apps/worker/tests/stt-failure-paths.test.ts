import { EventEmitter } from 'node:events';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import type {
  EngineEvent,
  NetFixtureScript,
  NetPort,
  SessionInput,
  WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet, duplexFromLegacy, type FixtureNet } from '@winsendotai/ovo-plugin-kit';
import { BoundedSpeechScheduler, NativeVoiceSessionEngine } from '@winsendotai/ovo-plugin-voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../packages/conformance/src/drivers/fake-clock.ts';
import {
  AssemblyAiStt,
  type AssemblyAiBinding,
} from '../../../packages/plugin-stt-assemblyai/src/provider.ts';
import { WorkerMediaLink } from '../src/worker-media-server.ts';
import { mediaRuntimeFixture, mediaSessionOpen } from './media-runtime-fixtures.ts';

/**
 * The paths that dropped the first live calls (2026-10-05), wired as the worker wires them: the
 * gateway's frames reach a real WorkerMediaLink before the engine exists, the native engine opens
 * AssemblyAI over a scripted socket, and the link replays its buffer once the session opens.
 * Pre-session buffer limits are in pre-session-buffer.test.ts.
 */

const FRAME_BYTES = 160; // 20 ms of 8 kHz mu-law, as Twilio sends it.
const source = 'https://www.assemblyai.com/docs/streaming/message-sequence';
const session: SessionInput = {
  mode: 'faq',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 600,
  acknowledgements: [],
};

function begin(id: string) {
  return {
    send: JSON.stringify({
      type: 'Begin',
      id,
      expires_at: '2026-10-06T00:00:00Z',
      configuration: { model: 'universal-streaming-english' },
    }),
  };
}

function assemblyAi(host: string, steps: NetFixtureScript['steps'] = []): NetFixtureScript {
  return {
    host,
    source,
    retrieved: '2026-10-06',
    steps: [
      { expect: 'ws-open', url: new RegExp(`^wss://${host.replaceAll('.', '\\.')}/`) },
      ...steps,
    ],
  };
}

/**
 * `ws` reports CLOSING as soon as a close frame arrives and emits 'close' only once TCP closes,
 * about a round trip later. The fixture socket does both at once; this holds the event back.
 */
function lingeringClose(net: FixtureNet, clock: FakeClock, delayMs: number): NetPort {
  return {
    fetch: (url, init) => net.fetch(url, init),
    websocket(url, opts) {
      const socket = net.websocket(url, opts);
      let closing = false;
      const on = (event: 'open' | 'message' | 'close' | 'error', fn: (...args: never[]) => void) =>
        event === 'close'
          ? socket.on('close', (code, reason) => {
              closing = true;
              clock.setTimeout(() => {
                closing = false;
                (fn as (code: number, reason: string) => void)(code, reason);
              }, delayMs);
            })
          : socket.on(event as 'message', fn as never);
      return {
        get readyState() {
          return closing ? 2 : socket.readyState;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        on: on as WebSocketLike['on'],
      };
    },
  };
}

function call(
  scripts: NetFixtureScript[],
  binding: AssemblyAiBinding = {},
  options: { closeEventDelayMs?: number } = {},
) {
  const clock = new FakeClock();
  const net = createFixtureNet(scripts, { clock });
  const port = options.closeEventDelayMs
    ? lingeringClose(net, clock, options.closeEventDelayMs)
    : net;
  const { route } = mediaRuntimeFixture();
  const gateway = new EventEmitter() as EventEmitter & {
    readyState: number;
    bufferedAmount: number;
    send(value: string, callback?: (error?: Error) => void): void;
    close(): void;
  };
  gateway.readyState = WebSocket.OPEN;
  gateway.bufferedAmount = 0;
  const sent: { type: string }[] = [];
  const held: (() => void)[] = [];
  const gatewayWrites = { hold: false };
  gateway.send = (value, callback) => {
    sent.push(JSON.parse(value) as { type: string });
    if (gatewayWrites.hold) held.push(() => callback?.());
    else callback?.();
  };
  gateway.close = vi.fn();
  const link = new WorkerMediaLink(mediaSessionOpen(route), gateway as unknown as WebSocket);
  const engine = new NativeVoiceSessionEngine({
    behavior: { respond: async () => '' },
    scheduler: new BoundedSpeechScheduler({
      async play() {
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    }),
    // The session graph hands the engine the link through this adapter in production.
    media: duplexFromLegacy(link, link.format, link.playbackEvidence, {
      carrierId: 'twilio',
      clearFlushesMarkers: link.clearFlushesMarkers,
    }),
    stt: new AssemblyAiStt(port, 'fixture-key', binding, clock),
    session,
    clock,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  let sequence = 0;
  const frame = (type: string, fields: object) =>
    gateway.emit('message', Buffer.from(JSON.stringify({ type, ...fields })), false);
  return {
    clock,
    net,
    link,
    engine,
    events,
    sent,
    /** Holds gateway write acknowledgements, as a slow socket flush would. */
    holdGatewayWrites() {
      gatewayWrites.hold = true;
    },
    releaseGatewayWrites() {
      gatewayWrites.hold = false;
      for (const ack of held.splice(0)) ack();
    },
    /** Caller audio from the gateway, 20 ms per frame. */
    speak(ms: number) {
      for (let at = 0; at < ms; at += 20)
        frame('media.audio', {
          payload: Buffer.alloc(FRAME_BYTES, 0xff).toString('base64'),
          sequenceNumber: ++sequence,
          timestampMs: sequence * 20,
        });
    },
    hangUp() {
      frame('session.close', { reason: 'carrier stream-ended' });
    },
  };
}

function sentBytes(net: FixtureNet, host?: string): number {
  return net.log
    .filter((entry) => entry.kind === 'ws-out' && entry.data instanceof Uint8Array)
    .filter((entry) => !host || entry.host === host)
    .reduce((total, entry) => total + (entry.data as Uint8Array).byteLength, 0);
}

function turn(transcript: string, end: boolean) {
  return {
    send: JSON.stringify({
      type: 'Turn',
      turn_order: 0,
      transcript,
      end_of_turn: end,
      turn_is_formatted: false,
    }),
  };
}

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('STT failure paths through the worker media link', () => {
  it('survives a 7 s handshake at a 4 s deadline by retrying within the buffer', async () => {
    // The primary is abandoned at 4 s and the retry begins 3 s later.
    const live = call(
      [
        assemblyAi('streaming.assemblyai.com'),
        assemblyAi('streaming.assemblyai.com', [
          { delayMs: 3_000 },
          begin('aa-retry'),
          { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
          { expect: 'ws-send', match: 'json', where: { type: 'Terminate' } },
          { send: JSON.stringify({ type: 'Termination', session_duration_seconds: 7 }) },
        ]),
      ],
      { connectTimeoutMs: 4_000 },
    );
    const starting = live.engine.start();
    live.speak(7_000);
    await live.clock.advanceAsync(6_999);
    expect(live.engine.ingressStats).toMatchObject({ overflows: 0 });
    await live.clock.advanceAsync(1);
    await starting;
    live.link.activate();
    live.speak(200);
    await vi.waitFor(() => expect(sentBytes(live.net)).toBeGreaterThan(7_200 * 8 - 400));
    expect(live.link.isClosed).toBe(false);
    expect(live.engine.ingressStats).toMatchObject({ overflows: 0 });
    await live.engine.dispose('behavior_completed');
    live.net.assertComplete();
  });

  it('holds seven seconds of audio across one 7 s Begin (buffer capacity only)', async () => {
    const live = call(
      [
        assemblyAi('streaming.assemblyai.com', [
          { delayMs: 7_000 },
          begin('aa-slow'),
          { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
        ]),
      ],
      // A single 8 s attempt: this pins that the worker and engine buffers hold a 7 s open.
      { connectTimeoutMs: 8_000 },
    );
    const starting = live.engine.start();
    live.speak(7_000);
    await live.clock.advanceAsync(7_000);
    await starting;
    live.link.activate();
    live.speak(200);
    await vi.waitFor(() => expect(sentBytes(live.net)).toBeGreaterThan(7_200 * 8 - 400));
    expect(live.link.isClosed).toBe(false);
    expect(live.engine.ingressStats).toMatchObject({ overflows: 0 });
    live.hangUp();
    await expect(live.engine.ended).resolves.toEqual({
      reason: 'caller_hangup',
      outcome: 'caller_ended',
    });
    live.net.assertComplete();
  });

  it('survives a primary region that never sends Begin by failing over within the buffer', async () => {
    // Default 6 s deadline: the primary is abandoned at 6 s and the fallback begins at 8.5 s.
    const live = call(
      [
        assemblyAi('streaming.us.assemblyai.com'),
        assemblyAi('streaming.eu.assemblyai.com', [
          { delayMs: 2_500 },
          begin('aa-fallback'),
          { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
        ]),
      ],
      { region: 'us', fallbackRegion: 'eu' },
    );
    const starting = live.engine.start();
    live.speak(8_500);
    await live.clock.advanceAsync(8_500);
    await starting;
    live.link.activate();
    await vi.waitFor(() =>
      expect(sentBytes(live.net, 'streaming.eu.assemblyai.com')).toBeGreaterThan(8_500 * 8 - 400),
    );
    expect(live.link.isClosed).toBe(false);
    await live.engine.dispose('behavior_completed');
  });

  it('holds 9 s of pre-session audio and replays all of it once STT opens', async () => {
    const live = call([
      assemblyAi('streaming.assemblyai.com', [
        { delayMs: 2_500 },
        begin('aa-burst'),
        { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
      ]),
    ]);
    const starting = live.engine.start();
    // The session open also waits on call records, telemetry and graph composition.
    live.speak(9_000);
    await live.clock.advanceAsync(2_500);
    await starting;
    expect(live.link.isClosed).toBe(false);
    live.link.activate();
    await vi.waitFor(() => expect(sentBytes(live.net)).toBeGreaterThan(9_000 * 8 - 400));
    expect(live.engine.ingressStats).toMatchObject({ overflows: 0 });
    await live.engine.dispose('behavior_completed');
  });

  // A provider that takes 7 s to Begin on every attempt is this case under the shipped 6 s default.
  it('fails the open with a typed connect-timeout when Begin never arrives', async () => {
    const live = call([
      assemblyAi('streaming.assemblyai.com'),
      assemblyAi('streaming.assemblyai.com'),
    ]);
    const starting = live.engine.start();
    const rejected = expect(starting).rejects.toMatchObject({ code: 'connect-timeout' });
    live.speak(12_000);
    await live.clock.advanceAsync(12_000);
    await rejected;
    // Both attempts fit the pre-session buffer, so the call ends on the STT cause, not overflow.
    expect(live.link.isClosed).toBe(false);
    await live.engine.dispose('error:session-open-failed');
    live.net.assertComplete();
  });

  it('reconnects after a 1011 mid-turn and still ends a hang-up as caller_hangup', async () => {
    const live = call([
      assemblyAi('streaming.assemblyai.com', [
        begin('aa-first'),
        { expect: 'ws-send', match: 'binary' },
        turn('my loan', false),
        { close: { code: 1011, reason: 'Internal error' } },
      ]),
      assemblyAi('streaming.assemblyai.com', [
        begin('aa-second'),
        { expect: 'ws-send', match: 'binary' },
        turn('my loan amount', true),
        { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
      ]),
    ]);
    await live.engine.start();
    live.link.activate();
    live.speak(100);
    await vi.waitFor(() =>
      expect(live.net.log.some((entry) => entry.kind === 'ws-close')).toBe(true),
    );
    // The next caller frame meets the closed socket and the ingress reconnects.
    live.speak(100);
    await vi.waitFor(() =>
      expect(
        live.events.some(
          (event) =>
            event.type === 'user.transcript' &&
            event.stability === 'final' &&
            event.segmentId === '0~r1',
        ),
      ).toBe(true),
    );
    live.speak(100);
    expect(live.link.isClosed).toBe(false);
    live.hangUp();
    // Regression: the hang-up was recorded as error:carrier stream-ended, outcome failed.
    await expect(live.engine.ended).resolves.toEqual({
      reason: 'caller_hangup',
      outcome: 'caller_ended',
    });
    expect(live.link.closedReason).toBe('caller_hangup');
    live.net.assertComplete();
  });

  it('reconnects when a write meets the socket closing before its close event', async () => {
    const live = call(
      [
        assemblyAi('streaming.assemblyai.com', [
          begin('aa-first'),
          { expect: 'ws-send', match: 'binary' },
          turn('my loan', false),
          { close: { code: 1011, reason: 'Internal error' } },
        ]),
        assemblyAi('streaming.assemblyai.com', [
          begin('aa-second'),
          { expect: 'ws-send', match: 'binary' },
          turn('my loan amount', true),
          { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
        ]),
      ],
      {},
      // About the closing window from the India VM to AssemblyAI US.
      { closeEventDelayMs: 200 },
    );
    await live.engine.start();
    live.link.activate();
    live.speak(100);
    await vi.waitFor(() =>
      expect(live.net.log.some((entry) => entry.kind === 'ws-close')).toBe(true),
    );
    // Regression: these frames met readyState 2 with no close code yet, and the call ended as
    // error:stt:write-failed without a reconnect.
    live.speak(100);
    await vi.waitFor(() =>
      expect(
        live.events.some(
          (event) =>
            event.type === 'user.transcript' &&
            event.stability === 'final' &&
            event.segmentId === '0~r1',
        ),
      ).toBe(true),
    );
    // The late close event of the dropped socket changes nothing.
    await live.clock.advanceAsync(200);
    live.speak(100);
    expect(live.link.isClosed).toBe(false);
    live.hangUp();
    await expect(live.engine.ended).resolves.toEqual({
      reason: 'caller_hangup',
      outcome: 'caller_ended',
    });
    live.net.assertComplete();
  });

  it('keeps the worker reason when the carrier stream ends while the worker is closing', async () => {
    const live = call([
      assemblyAi('streaming.assemblyai.com', [
        begin('aa-close'),
        { expect: 'ws-send', match: 'json', where: { type: 'Terminate' } },
        { send: JSON.stringify({ type: 'Termination', session_duration_seconds: 1 }) },
      ]),
    ]);
    await live.engine.start();
    live.link.activate();
    const reasons: string[] = [];
    live.link.onClose((reason) => reasons.push(reason));
    live.holdGatewayWrites();
    const ending = live.engine.dispose('behavior_completed');
    // The carrier's stop arrives after the worker's session.end but before that write flushes.
    await vi.waitFor(() =>
      expect(live.sent).toContainEqual({ type: 'session.end', reason: 'behavior_completed' }),
    );
    expect(live.link.isClosed).toBe(false);
    live.hangUp();
    live.releaseGatewayWrites();
    await expect(ending).resolves.toEqual({
      reason: 'behavior_completed',
      outcome: 'completed',
    });
    expect(reasons).toEqual(['behavior_completed']);
  });
});
