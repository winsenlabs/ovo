import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AgentConfig, type CarrierHostPorts, type DialRequest } from '@winsendotai/ovo-contracts';
import { compose, type Composition } from '@winsendotai/ovo-runtime';
import { MediaGateway } from '@winsendotai/ovo-plugin-media';
import {
  fixtureCarrierIngress,
  fixtureSignature,
  fixtureWebhook,
  signFixtureRequest,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
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
  type DurableQueue,
  type JobReference,
  type QueueDelivery,
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
import type { WorkerCarrierRuntime, SelectedJobCarrier } from '../src/carrier-runtime.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

class FixtureQueue implements DurableQueue {
  private pending: QueueDelivery[] = [];
  async send(reference: JobReference) {
    const messageId = randomUUID();
    this.pending.push({ messageId, receiptHandle: messageId, reference, receiveCount: 1 });
    return { messageId };
  }
  async receive(options: { maxMessages?: number; waitSeconds?: number } = {}) {
    return this.pending.slice(0, options.maxMessages ?? 1);
  }
  async delete(delivery: QueueDelivery) {
    this.pending = this.pending.filter((row) => row.messageId !== delivery.messageId);
  }
  async changeVisibility() {}
}

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
      if ((this.buffer[0]! & 0x0f) === 8) {
        this.socket.destroy();
        return;
      }
      if ((this.buffer[0]! & 0x0f) === 1)
        this.messages.push(this.buffer.subarray(header, header + length).toString());
      this.buffer = this.buffer.subarray(header + length);
    }
  }
}

async function connectCarrier(port: number, authToken: string): Promise<RawCarrier> {
  const socket = createConnection({ host: '127.0.0.1', port });
  const key = randomBytes(16).toString('base64');
  const path = '/carriers/fixture/env/media';
  const signature = fixtureSignature(authToken, `wss://voice.example.test${path}`);
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nx-fixture-signature: ${signature}\r\n\r\n`,
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

describe.skipIf(!postgresUrl)('worker PostgreSQL and fixture-queue lifecycle', () => {
  it('publishes one durable job, authenticates its route, dials once and releases once', async () => {
    const store = new PostgresOrchestrationStore({ connectionString: postgresUrl });
    const control = await PostgresControlStore.open(postgresUrl!);
    const queue = new FixtureQueue();
    const jobId = randomUUID();
    const organizationId = `single-org-e2e-${jobId}`;
    const workerId = `worker-e2e-${jobId}`;
    const carrier = new SyntheticCarrier();
    const protection = new SyntheticProtection();
    let gateway: MediaGateway | undefined;
    let resumeGateway: MediaGateway | undefined;
    let mediaRuntime: WorkerMediaRuntime | undefined;
    let mediaCarrier: RawCarrier | undefined;
    let resumedCarrier: RawCarrier | undefined;
    let healthServer: Server | undefined;
    let callComposition: Composition | undefined;
    let engineCreates = 0;
    let sttWrites = 0;
    let resumeToken: string | undefined;
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
      healthServer = createServer((_request, response) => response.writeHead(404).end());
      healthServer.listen(0, '127.0.0.1');
      await once(healthServer, 'listening');
      const address = healthServer.address();
      if (!address || typeof address === 'string') throw new Error('health port unavailable');
      const workerEndpoint = `ws://127.0.0.1:${address.port}/internal/media`;
      await store.reportWorker({
        workerId,
        state: 'active',
        ownershipEpoch: 1,
        leaseMs: 120_000,
      });
      const ingress = fixtureCarrierIngress();
      const dialRequests: DialRequest[] = [];
      const carriers = {
        async forJob(): Promise<SelectedJobCarrier> {
          return {
            release,
            selections: {},
            carrier: {
              carrierId: ingress.carrierId,
              bindingId: 'env',
              capabilities: ingress.capabilities,
            },
            control: {
              async dial(request: DialRequest) {
                dialRequests.push(request);
                return {
                  kind: 'accepted' as const,
                  requestId: request.requestId,
                  carrierCallId: 'CA-e2e',
                };
              },
            },
            ports: {
              mediaUrl: () => 'wss://voice.example.test/carriers/fixture/env/media',
              callbackUrl: (_carrierId: string, _bindingId: string, purpose: string) =>
                `https://voice.example.test/carriers/fixture/env/${purpose}`,
            },
          } as unknown as SelectedJobCarrier;
        },
      } as unknown as WorkerCarrierRuntime;
      await store.enqueue({
        id: jobId,
        workspaceId: organizationId,
        idempotencyKey: 'one-carrier-side-effect',
        payload: {
          to: '+910000000001',
          from: '+910000000002',
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
        workerId,
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
          workerEndpoint,
          organizationId,
          handshakeTtlMs: 60_000,
          carriers,
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
      expect(dialRequests).toHaveLength(1);
      expect(await control.getCall(organizationId, jobId)).toMatchObject({
        releaseId: release.id,
        kind: 'live',
        status: 'dialing',
      });
      const token = dialRequests[0]!.media.routeParams.rt;
      expect(dialRequests[0]!.media.routeParams.sid).toBe(outcome.sessionId);
      expect(token).toBeTruthy();
      let responses = 0;
      const gatewayConfig = {
        publicBaseUrl: 'https://voice.example.test',
        workerToken: 'worker-fixture',
        ingresses: [ingress],
        drainTimeoutMs: 100,
        hostFor: () =>
          ({
            resolveBinding: async () => ({
              bindingId: 'env',
              pluginId: 'fixture',
              workspaceId: organizationId,
              config: {},
              secret: 'fixture-secret',
            }),
            verifyUrlSecret: () => true,
            async resumeStream() {
              const token = randomBytes(32).toString('base64url');
              const route = await store.reissueStream({
                organizationId,
                carrierId: ingress.carrierId,
                carrierCallId: 'CA-e2e',
                tokenHash: createHash('sha256').update(token).digest('hex'),
                expiresAt: new Date(Date.now() + 60_000),
                workerFreshSeconds: 60,
              });
              if (!route) return undefined;
              resumeToken = token;
              return {
                kind: 'stream' as const,
                mediaUrl: 'wss://voice.example.test/carriers/fixture/env/media',
                routeParams: { sid: route.sessionId, rt: token },
              };
            },
          }) as unknown as CarrierHostPorts,
      };
      gateway = new MediaGateway(store, gatewayConfig);
      const { port } = await gateway.listen();
      // Model the carrier opening its stream before dial acceptance is persisted.
      await store.pool.query(
        "UPDATE ovo_session_routes SET status = 'dialing' WHERE session_id = $1",
        [outcome.sessionId],
      );
      await store.pool.query("UPDATE ovo_jobs SET status = 'dialing' WHERE id = $1", [jobId]);
      mediaRuntime = new WorkerMediaRuntime(
        { httpServer: healthServer, workerId, token: 'worker-fixture' },
        store,
        {
          async create(input) {
            engineCreates += 1;
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
                    sttWrites += 1;
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
      await mediaRuntime.start();
      mediaCarrier = await connectCarrier(port, 'fixture-secret');
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
      const opened = await store.pool.query<{ status: string }>(
        `SELECT status FROM ovo_carrier_callbacks WHERE session_id = $1
           AND organization_id = $2 AND carrier_id = $3 AND provider = 'ovo.media'`,
        [outcome.sessionId, organizationId, ingress.carrierId],
      );
      expect(opened.rows).toEqual([{ status: 'session_opened' }]);

      await store.applyCarrierCallback({
        organizationId,
        carrierId: ingress.carrierId,
        provider: 'synthetic',
        eventId: 'e2e-answered',
        dialRequestId: dialRequests[0]!.requestId,
        carrierCallId: 'CA-e2e',
        status: 'answered',
        occurredAt: new Date(),
      });
      expect(engineCreates).toBe(1);
      const beforeResume = await store.getSessionRoute(jobId);
      await gateway.drain();
      resumeGateway = new MediaGateway(store, gatewayConfig);
      const resumed = await resumeGateway.listen();
      const resumeRequest = signFixtureRequest(
        'fixture-secret',
        fixtureWebhook({
          externalUrl: 'https://voice.example.test/carriers/fixture/env/resume?r=CA-e2e&t=fixture',
          bindingId: 'env',
          query: { r: 'CA-e2e', t: 'fixture' },
          form: { CallSid: 'CA-e2e' },
        }),
      );
      const resumeResponse = await fetch(
        `http://127.0.0.1:${resumed.port}/carriers/fixture/env/resume?r=CA-e2e&t=fixture`,
        {
          method: 'POST',
          headers: Object.fromEntries(
            Object.entries(resumeRequest.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
          body: new TextDecoder().decode(resumeRequest.rawBody),
        },
      );
      expect(resumeResponse.status).toBe(200);
      const markup = await resumeResponse.text();
      expect(resumeToken).toBeTruthy();
      expect(markup).toContain(resumeToken);
      const resumedRoute = await store.getSessionRoute(jobId);
      expect(resumedRoute?.generation).toBe((beforeResume?.generation ?? 0) + 1);
      resumedCarrier = await connectCarrier(resumed.port, 'fixture-secret');
      resumedCarrier.send({
        event: 'start',
        sequenceNumber: '1',
        streamSid: 'MZ-e2e-resumed',
        start: {
          accountSid: 'AC-e2e',
          callSid: 'CA-e2e',
          customParameters: { sessionId: outcome.sessionId, routeToken: resumeToken },
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: '8000', channels: '1' },
        },
      });
      resumedCarrier.send({
        event: 'media',
        sequenceNumber: '2',
        streamSid: 'MZ-e2e-resumed',
        media: { track: 'inbound', chunk: '1', timestamp: '20', payload: 'Ag==' },
      });
      await expect.poll(() => sttWrites).toBe(2);
      expect(engineCreates).toBe(1);
      await store.applyCarrierCallback({
        organizationId,
        carrierId: ingress.carrierId,
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
      resumedCarrier?.close();
      await gateway?.close();
      await resumeGateway?.close();
      await mediaRuntime?.close();
      await new Promise<void>((resolve) => healthServer?.close(() => resolve()) ?? resolve());
      await callComposition?.dispose();
      await control.close();
      await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id = $1', [jobId]);
      await store.pool.query('DELETE FROM ovo_jobs WHERE id = $1', [jobId]);
      await store.pool.query('DELETE FROM ovo_worker_slots WHERE worker_id = $1', [workerId]);
      await store.close();
    }
  });
});
