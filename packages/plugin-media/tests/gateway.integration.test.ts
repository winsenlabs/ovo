import { createHmac } from 'node:crypto';
import { connectRaw as connectRawSocket, type RawWebSocket } from './gateway-socket-fixture.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeechReceipt } from '@winsendotai/ovo-contracts';
import {
  BoundedSpeechScheduler,
  StreamingMediaSpeechOutput,
  VoiceSessionEngine,
  type StreamingStt,
  type StreamingTts,
} from '@winsendotai/ovo-plugin-voice';
import { MediaGateway } from '../src/gateway.ts';
import type { DurableMediaRoute, MediaRouteResolver } from '../src/ports.ts';
import { WorkerGatewayClient, type WorkerMediaSession } from '../src/worker-client.ts';

const resources: { close(): void | Promise<void> }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0).reverse()) await item.close();
});

async function connectRaw(port: number, path: string, signature: string): Promise<RawWebSocket> {
  const socket = await connectRawSocket(port, path, signature);
  resources.push(socket);
  return socket;
}

class TestRouteResolver implements MediaRouteResolver {
  private claimed = false;
  readonly callbacks: unknown[] = [];
  readonly route: DurableMediaRoute = {
    sessionId: 'session-1',
    workerId: 'worker-1',
    ownerEpoch: 1,
    generation: 1,
    carrierCallId: 'CA1',
    status: 'accepted',
  };
  async authenticateSessionRoute(sessionId: string, token: string) {
    if (this.claimed || sessionId !== this.route.sessionId || token !== 'route-token')
      return undefined;
    this.claimed = true;
    return this.route;
  }
  async resolveSessionRoute(input: { carrierCallId: string }) {
    return input.carrierCallId === this.route.carrierCallId ? this.route : undefined;
  }
  async applyCarrierCallback(input: unknown) {
    this.callbacks.push(input);
    return { kind: 'applied' };
  }
}

function signature(token: string, externalUrl: string): string {
  return createHmac('sha1', token).update(externalUrl).digest('base64');
}

function formSignature(token: string, externalUrl: string, parameters: Record<string, string>) {
  const value =
    externalUrl +
    Object.keys(parameters)
      .sort()
      .map((key) => `${key}${parameters[key]}`)
      .join('');
  return createHmac('sha1', token).update(value).digest('base64');
}

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true));
}

function start(streamSid = 'MZ1') {
  return {
    event: 'start',
    sequenceNumber: '1',
    streamSid,
    start: {
      accountSid: 'AC1',
      callSid: 'CA1',
      customParameters: { sessionId: 'session-1', routeToken: 'route-token' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: '8000', channels: '1' },
    },
  };
}

async function setup(
  onSession: (session: WorkerMediaSession) => void | Promise<void>,
  overrides = {},
) {
  const resolver = new TestRouteResolver();
  const token = 'internal-test-token';
  const twilioToken = 'twilio-test-token';
  const gateway = new MediaGateway(resolver, {
    publicBaseUrl: 'https://voice.example.test',
    twilioAuthToken: twilioToken,
    workerToken: token,
    handshakeTimeoutMs: 1_000,
    idleTimeoutMs: 5_000,
    drainTimeoutMs: 100,
    ...overrides,
  });
  const { port } = await gateway.listen();
  resources.push(gateway);
  const worker = new WorkerGatewayClient(
    { url: `ws://127.0.0.1:${port}/worker`, workerId: 'worker-1', token },
    onSession,
  );
  await worker.connect();
  resources.push(worker);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const path = '/twilio/media?edge=loopback';
  const carrier = await connectRaw(
    port,
    path,
    signature(twilioToken, `https://voice.example.test${path}`),
  );
  return { carrier, port, resolver };
}

describe('media gateway loopback protocol', () => {
  it('accepts an initial announcement before the engine sends its first audio', async () => {
    let engine: VoiceSessionEngine | undefined;
    const harness = await setup(async (session) => {
      const tts: StreamingTts = {
        async *synthesize() {
          yield Uint8Array.of(1, 2, 3);
        },
      };
      engine = new VoiceSessionEngine(
        { respond: async () => 'Hello from the accepted call.' },
        new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, session)),
        undefined,
        session,
        { inputEnabled: false, initialInput: '' },
      );
      await engine.start();
    });
    harness.carrier.send(start());
    await until(() => harness.carrier.messages.some((raw) => JSON.parse(raw).event === 'mark'));
    expect(harness.carrier.closed).toBe(false);
    expect(harness.carrier.messages.map((raw) => JSON.parse(raw).event)).toContain('media');
    const mark = harness.carrier.messages
      .map((raw) => JSON.parse(raw))
      .find((message) => message.event === 'mark');
    harness.carrier.send({
      event: 'mark',
      sequenceNumber: '2',
      streamSid: 'MZ1',
      mark: { name: mark.mark.name },
    });
    await engine?.dispose();
  });

  it('validates and projects Twilio status callbacks with stable event identity', async () => {
    const resolver = new TestRouteResolver();
    const gateway = new MediaGateway(resolver, {
      publicBaseUrl: 'https://voice.example.test',
      twilioAuthToken: 'twilio-test-token',
      workerToken: 'worker-token',
    });
    const { port } = await gateway.listen();
    resources.push(gateway);
    const parameters = { CallSid: 'CA1', CallStatus: 'completed', SequenceNumber: '4' };
    const externalUrl = 'https://voice.example.test/twilio/status?ovoRequestId=job-1%3A1';
    const response = await fetch(`http://127.0.0.1:${port}/twilio/status?ovoRequestId=job-1%3A1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': formSignature('twilio-test-token', externalUrl, parameters),
      },
      body: new URLSearchParams(parameters),
    });
    expect(response.status).toBe(204);
    expect(resolver.callbacks).toEqual([
      expect.objectContaining({
        eventId: 'CA1:4',
        dialRequestId: 'job-1:1',
        carrierCallId: 'CA1',
        status: 'completed',
      }),
    ]);
  });

  it('runs a fake streaming provider turn through the actual worker and carrier sockets', async () => {
    const receipts: SpeechReceipt[] = [];
    let responses = 0;
    let engine: VoiceSessionEngine | undefined;
    const tts: StreamingTts = {
      async *synthesize() {
        yield Uint8Array.of(9, 8, 7);
      },
    };
    const stt: StreamingStt = {
      async start(input) {
        let emitted = false;
        return {
          write: async () => {
            if (emitted) return;
            emitted = true;
            input.onTranscript({
              revision: 1,
              text: 'hello',
              isFinal: true,
              speechFinal: true,
            });
          },
          finish: async () => undefined,
          close: async () => undefined,
        };
      },
    };
    const harness = await setup(async (session) => {
      const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, session));
      engine = new VoiceSessionEngine(
        {
          respond: async () => {
            responses += 1;
            return 'socket reply';
          },
          onPlayback: async (receipt) => {
            receipts.push(receipt);
          },
        },
        scheduler,
        stt,
        session,
        { language: 'en-IN' },
      );
      await engine.start();
    });
    harness.carrier.send(start());
    await until(() => Boolean(engine));
    harness.carrier.send({
      event: 'media',
      sequenceNumber: '2',
      streamSid: 'MZ1',
      media: { track: 'inbound', chunk: '1', timestamp: '20', payload: 'AQ==' },
    });
    await until(() => harness.carrier.messages.some((item) => JSON.parse(item).event === 'mark'));
    const mark = harness.carrier.messages
      .map((item) => JSON.parse(item))
      .find((item) => item.event === 'mark');
    harness.carrier.send({
      event: 'mark',
      sequenceNumber: '3',
      streamSid: 'MZ1',
      mark: { name: mark.mark.name },
    });
    await until(() => receipts.length === 1);
    expect(responses).toBe(1);
    expect(receipts[0]).toMatchObject({
      state: 'completed',
      evidence: 'confirmed',
      text: 'socket reply',
    });
    harness.carrier.send({
      event: 'stop',
      sequenceNumber: '4',
      streamSid: 'MZ1',
      stop: { accountSid: 'AC1', callSid: 'CA1' },
    });
    await engine!.dispose();
  });

  it('routes signed 8 kHz mu-law frames only to the durable owner and carries mark/clear', async () => {
    let session: WorkerMediaSession | undefined;
    const inbound: number[][] = [];
    const marks: string[] = [];
    const closeReasons: string[] = [];
    const harness = await setup((created) => {
      session = created;
      created.onAudio((audio) => inbound.push([...audio]));
      created.onMark((name) => marks.push(name));
      created.onClose((reason) => closeReasons.push(reason));
    });
    harness.carrier.send(start());
    await until(() => Boolean(session));
    harness.carrier.send({
      event: 'media',
      sequenceNumber: '2',
      streamSid: 'MZ1',
      media: {
        track: 'inbound',
        chunk: '1',
        timestamp: '20',
        payload: Buffer.from([1, 2]).toString('base64'),
      },
    });
    await until(() => inbound.length === 1);
    await session!.sendAudio(Uint8Array.of(3, 4));
    await session!.sendMark('speech-1:1');
    await session!.clear();
    await until(() => harness.carrier.messages.length >= 3);
    expect(harness.carrier.messages.map((item) => JSON.parse(item).event)).toEqual([
      'media',
      'mark',
      'clear',
    ]);
    harness.carrier.send({
      event: 'mark',
      sequenceNumber: '3',
      streamSid: 'MZ1',
      mark: { name: 'speech-1:1' },
    });
    await until(() => marks.length === 1);
    expect(inbound).toEqual([[1, 2]]);
    expect(marks).toEqual(['speech-1:1']);
    harness.carrier.send({
      event: 'stop',
      sequenceNumber: '4',
      streamSid: 'MZ1',
      stop: { accountSid: 'AC1', callSid: 'CA1' },
    });
    await until(() => closeReasons.includes('carrier stopped'));
  });

  it('rejects a signature computed for any URL other than the exact public URL', async () => {
    const resolver = new TestRouteResolver();
    const gateway = new MediaGateway(resolver, {
      publicBaseUrl: 'https://voice.example.test',
      twilioAuthToken: 'token',
      workerToken: 'worker',
    });
    const { port } = await gateway.listen();
    resources.push(gateway);
    await expect(
      connectRaw(
        port,
        '/twilio/media?edge=a',
        signature('token', 'https://voice.example.test/twilio/media?edge=b'),
      ),
    ).rejects.toThrow('401');
  });

  it('admits one route winner and cancels when pre-accept backpressure exceeds its bound', async () => {
    const standalone = new TestRouteResolver();
    const winners = await Promise.all(
      Array.from({ length: 10 }, () =>
        standalone.authenticateSessionRoute('session-1', 'route-token'),
      ),
    );
    expect(winners.filter(Boolean)).toHaveLength(1);

    let session: WorkerMediaSession | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = await setup(
      async (created) => {
        session = created;
        await gate;
      },
      { maxPendingFrames: 1 },
    );
    harness.carrier.send(start());
    await until(() => Boolean(session));
    const media = (sequence: string) => ({
      event: 'media',
      sequenceNumber: sequence,
      streamSid: 'MZ1',
      media: { track: 'inbound', chunk: sequence, timestamp: sequence, payload: 'AQ==' },
    });
    harness.carrier.send(media('2'));
    harness.carrier.send(media('3'));
    await until(() => harness.carrier.closed);
    release();
  });
});
