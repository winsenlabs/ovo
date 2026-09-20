import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { compose, type Composition } from '@winsendotai/ovo-runtime';
import { MediaGateway } from '@winsendotai/ovo-plugin-media';
import { PostgresControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  BoundedSpeechScheduler,
  StreamingMediaSpeechOutput,
  VoiceSessionEngine,
  type StreamingStt,
  type StreamingTts,
} from '@winsendotai/ovo-plugin-voice';
import {
  OutboxPublisher,
  PostgresOrchestrationStore,
  SqsDurableQueue,
  type TaskProtection,
  type TelephonyControl,
  type TelephonyDialRequest,
} from '@winsendotai/ovo-plugin-orchestration';
import {
  CALL_RECORDER_SERVICE_KEY,
  WorkerMediaRuntime,
  WorkerRunner,
  createCallRecorderPlugin,
  type CallRecorder,
} from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const queueUrl = process.env.OVO_TEST_QUEUE_URL;
const queueEndpoint = process.env.OVO_TEST_QUEUE_ENDPOINT;

class SyntheticProtection implements TaskProtection {
  established = 0;
  released = 0;
  async establish() {
    this.established += 1;
    return true;
  }
  async renew() {
    return true;
  }
  async release() {
    this.released += 1;
  }
}

class SyntheticCarrier implements TelephonyControl {
  requests: TelephonyDialRequest[] = [];
  async dial(request: TelephonyDialRequest) {
    this.requests.push(request);
    return { kind: 'accepted' as const, requestId: request.requestId, carrierCallId: 'CA-e2e' };
  }
  async reconcile() {
    return { kind: 'accepted' as const, carrierCallId: 'CA-e2e' };
  }
  async hangup() {}
  async transfer() {}
}

class RawCarrier {
  readonly messages: string[] = [];
  private buffer = Buffer.alloc(0);
  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk) => this.consume(chunk));
  }
  send(message: unknown) {
    const payload = Buffer.from(JSON.stringify(message));
    const mask = randomBytes(4);
    const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
    header[0] = 0x81;
    if (payload.length < 126) header[1] = 0x80 | payload.length;
    else {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const offset = payload.length < 126 ? 2 : 4;
    mask.copy(header, offset);
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!;
    this.socket.write(Buffer.concat([header, payload]));
  }
  close() {
    this.socket.destroy();
  }
  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const code = this.buffer[1]! & 0x7f;
      const header = code < 126 ? 2 : code === 126 ? 4 : 10;
      if (this.buffer.length < header) return;
      const length =
        code < 126
          ? code
          : code === 126
            ? this.buffer.readUInt16BE(2)
            : Number(this.buffer.readBigUInt64BE(2));
      if (this.buffer.length < header + length) return;
      if ((this.buffer[0]! & 0x0f) === 1)
        this.messages.push(this.buffer.subarray(header, header + length).toString());
      this.buffer = this.buffer.subarray(header + length);
    }
  }
}

async function connectCarrier(port: number, authToken: string): Promise<RawCarrier> {
  const socket = createConnection({ host: '127.0.0.1', port });
  const key = randomBytes(16).toString('base64');
  const path = '/twilio/media';
  const signature = createHmac('sha1', authToken)
    .update(`https://voice.example.test${path}`)
    .digest('base64');
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nX-Twilio-Signature: ${signature}\r\n\r\n`,
  );
  const response = await new Promise<string>((resolve, reject) => {
    let value = '';
    const receive = (chunk: Buffer) => {
      value += chunk.toString('latin1');
      if (!value.includes('\r\n\r\n')) return;
      socket.off('data', receive);
      resolve(value);
    };
    socket.on('data', receive);
    socket.once('error', reject);
  });
  if (!response.startsWith('HTTP/1.1 101')) throw new Error(response.split('\r\n')[0]);
  return new RawCarrier(socket);
}

describe.skipIf(!postgresUrl || !queueUrl || !queueEndpoint)(
  'worker PostgreSQL and ElasticMQ lifecycle',
  () => {
    it('publishes one durable job, authenticates its route, dials once and releases once', async () => {
      const store = new PostgresOrchestrationStore({ connectionString: postgresUrl });
      const control = await PostgresControlStore.open(postgresUrl!);
      const queue = new SqsDurableQueue(queueUrl!, {
        region: 'local',
        endpoint: queueEndpoint,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      });
      const jobId = randomUUID();
      const organizationId = `single-org-e2e-${jobId}`;
      const carrier = new SyntheticCarrier();
      const protection = new SyntheticProtection();
      let gateway: MediaGateway | undefined;
      let mediaRuntime: WorkerMediaRuntime | undefined;
      let mediaCarrier: RawCarrier | undefined;
      let callComposition: Composition | undefined;
      try {
        await store.migrate();
        await control.ensureWorkspace(organizationId, 'E2E organization');
        const agent = await control.createAgent(
          organizationId,
          AgentConfig.parse({ name: 'E2E announcement', mode: 'announcement', message: 'Hello' }),
        );
        const release = await control.createRelease({
          workspaceId: organizationId,
          agent,
          plugins: [{ id: '@winsendotai/ovo-behavior-announcement', version: '0.1.0' }],
          createdBy: 'test-operator',
        });
        await store.enqueue({
          id: jobId,
          workspaceId: organizationId,
          idempotencyKey: 'one-carrier-side-effect',
          payload: {
            to: '+910000000001',
            from: '+910000000002',
            streamUrl: 'wss://voice.example.test/twilio/media',
            statusCallbackUrl: 'https://voice.example.test/callbacks/twilio/status',
            releaseId: release.id,
            callId: jobId,
          },
        });
        expect(await new OutboxPublisher('e2e-dispatcher', store, queue).flush()).toEqual({
          sent: 1,
          failed: 0,
        });
        const [delivery] = await queue.receive({ maxMessages: 1, waitSeconds: 1 });
        if (!delivery) throw new Error('expected ElasticMQ delivery');
        const runner = new WorkerRunner(
          'worker-e2e',
          store,
          queue,
          {
            async check() {
              return { ready: true as const };
            },
          },
          protection,
          carrier,
          {
            leaseMs: 60_000,
            protectionRenewMs: 120_000,
            deferSeconds: 1,
            visibilitySeconds: 120,
            workerEndpoint: 'ws://worker-e2e:4100/internal/media',
            organizationId,
            handshakeTtlMs: 60_000,
            callRecorder: await (async () => {
              const plugin = createCallRecorderPlugin(control);
              callComposition = await compose([{ id: plugin.manifest.id, config: {} }], [plugin]);
              return callComposition.ctx.get(CALL_RECORDER_SERVICE_KEY) as CallRecorder;
            })(),
          },
        );
        const outcome = await runner.handle(delivery);
        expect(outcome).toMatchObject({ kind: 'accepted', carrierCallId: 'CA-e2e' });
        if (outcome.kind !== 'accepted') throw new Error('expected accepted outcome');
        expect(carrier.requests).toHaveLength(1);
        expect(await control.getCall(organizationId, jobId)).toMatchObject({
          releaseId: release.id,
          kind: 'live',
          status: 'dialing',
        });
        const token = carrier.requests[0]!.streamParameters?.routeToken;
        expect(carrier.requests[0]!.streamParameters?.sessionId).toBe(outcome.sessionId);
        expect(token).toBeTruthy();
        let responses = 0;
        gateway = new MediaGateway(store, {
          publicBaseUrl: 'https://voice.example.test',
          twilioAuthToken: 'twilio-fixture',
          workerToken: 'worker-fixture',
        });
        const { port } = await gateway.listen();
        mediaRuntime = new WorkerMediaRuntime(
          { url: `ws://127.0.0.1:${port}/worker`, workerId: 'worker-e2e', token: 'worker-fixture' },
          store,
          {
            async create(input) {
              expect((await control.getRelease(organizationId, release.id))?.id).toBe(release.id);
              const tts: StreamingTts = {
                async *synthesize() {
                  yield Uint8Array.of(1, 2, 3);
                },
              };
              const stt: StreamingStt = {
                async start(start) {
                  return {
                    async write() {
                      start.onTranscript({
                        revision: 1,
                        text: 'hello',
                        isFinal: true,
                        speechFinal: true,
                      });
                    },
                    async finish() {},
                    async close() {},
                  };
                },
              };
              const engine = new VoiceSessionEngine(
                {
                  async respond() {
                    responses += 1;
                    return 'world';
                  },
                },
                new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, input.media)),
                stt,
                input.media,
                { language: 'en-IN' },
              );
              await engine.start();
              return engine;
            },
          },
        );
        await mediaRuntime.connect();
        mediaCarrier = await connectCarrier(port, 'twilio-fixture');
        mediaCarrier.send({
          event: 'start',
          sequenceNumber: '1',
          streamSid: 'MZ-e2e',
          start: {
            accountSid: 'AC-e2e',
            callSid: 'CA-e2e',
            customParameters: { sessionId: outcome.sessionId, routeToken: token },
            mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: '8000', channels: '1' },
          },
        });
        mediaCarrier.send({
          event: 'media',
          sequenceNumber: '2',
          streamSid: 'MZ-e2e',
          media: { track: 'inbound', chunk: '1', timestamp: '20', payload: 'AQ==' },
        });
        await expect.poll(() => responses).toBe(1);
        await expect
          .poll(() => mediaCarrier!.messages.some((value) => JSON.parse(value).event === 'mark'))
          .toBe(true);

        await store.applyCarrierCallback({
          provider: 'synthetic',
          eventId: 'e2e-answered',
          dialRequestId: carrier.requests[0]!.requestId,
          carrierCallId: 'CA-e2e',
          status: 'answered',
          occurredAt: new Date(),
        });
        await store.applyCarrierCallback({
          provider: 'synthetic',
          eventId: 'e2e-completed',
          carrierCallId: 'CA-e2e',
          status: 'completed',
          occurredAt: new Date(),
        });
        outcome.lease.stop();
        await outcome.protection.release();
        await control.finishCall(organizationId, jobId, 'completed');
        expect(await store.releaseTerminalSession(jobId)).toBe(true);
        expect(await store.releaseTerminalSession(jobId)).toBe(false);
        expect(protection).toMatchObject({ established: 1, released: 1 });
        expect(await queue.receive({ maxMessages: 1, waitSeconds: 0 })).toEqual([]);
      } finally {
        mediaCarrier?.close();
        await mediaRuntime?.close();
        await gateway?.close();
        await callComposition?.dispose();
        await control.close();
        await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id = $1', [jobId]);
        await store.pool.query('DELETE FROM ovo_jobs WHERE id = $1', [jobId]);
        await store.close();
        queue.destroy();
      }
    });
  },
);
