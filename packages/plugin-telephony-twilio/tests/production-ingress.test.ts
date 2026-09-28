import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import twilio from 'twilio';
import { WebSocket } from '../../plugin-media/src/index.ts';
import { expect, it, vi } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type CarrierControlFactory,
  type CarrierIngress,
} from '../../contracts/src/index.ts';
import { compose } from '@winsendotai/ovo-runtime';
import { createFixtureNet } from '../../plugin-kit/src/index.ts';
import { createFakeCarrierHostPorts } from '../../conformance/src/drivers/carrier-host-ports.ts';
import { withEgressSentinel } from '../../conformance/src/drivers/egress-sentinel.ts';
import { loadDistribution } from '../../distribution/src/load.ts';
import { CarrierRegistry } from '../../session-host/src/carrier-registry.ts';
import { MediaGateway } from '../../plugin-media/src/gateway.ts';
import {
  attachWorkerMediaServer,
  WorkerMediaLink,
} from '../../../apps/worker/src/worker-media-server.ts';
import type { DurableMediaRoute } from '../../plugin-media/src/ports.ts';

const id = '@winsendotai/ovo-carrier-twilio';
const publicBase = 'https://voice.example.test';
const binding = {
  bindingId: 'b1',
  pluginId: id,
  workspaceId: 'w1',
  config: { accountSid: 'AC00000000000000000000000000000000' },
  secret: 'synthetic-c1-token',
};
const sign = (url: string, body: Record<string, string> = {}) =>
  createHmac('sha1', binding.secret)
    .update(
      url +
        Object.keys(body)
          .sort()
          .map((key) => key + body[key])
          .join(''),
    )
    .digest('base64');
const fields = { CallSid: 'CAfixture', CallStatus: 'completed', SequenceNumber: '3' };

async function installed() {
  const distribution = await loadDistribution({
    role: 'gateway',
    profile: 'compose',
    env: {},
    log() {},
  });
  const definition = distribution.catalog.find((item) => item.manifest.id === id)!;
  const net = createFixtureNet([
    {
      host: 'api.twilio.com',
      source: 'https://www.twilio.com/docs/voice/api/call-resource',
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: `https://api.twilio.com/2010-04-01/Accounts/${binding.config.accountSid}/Calls.json`,
          body: 'form',
          reply: { status: 201, body: JSON.stringify({ sid: fields.CallSid }) },
        },
      ],
    },
  ]);
  const graph = await compose(
    distribution.processRows.filter((row) => row.id === id),
    [definition],
    { scope: 'process', net },
  );
  const factory = graph.all(Cap.carrierControl).get('twilio') as CarrierControlFactory;
  const registry = new CarrierRegistry(
    new Map([[id, { version: definition.manifest.version, factory }]]),
    async () => binding,
  );
  const selected = await registry.forRelease({
    selections: {
      carrier: { pluginId: id, version: definition.manifest.version, bindingId: 'b1', config: {} },
    },
  });
  return {
    graph,
    net,
    selected,
    ingress: graph.all(Cap.carrierIngress).get(selected.carrierId) as CarrierIngress | undefined,
  };
}

it('proves the genuine Twilio validator requires the HTTP raw query, and routes that signature through the production gateway', async () => {
  await withEgressSentinel(
    async (sentinel) => {
      const loaded = await installed();
      const callbackPath = '/carriers/twilio/b1/status?r=dial-1&t=token&raw=%2f+%20&other=%2F';
      const externalUrl = publicBase + callbackPath;
      const signature = sign(externalUrl, fields);
      // Genuine installed SDK, no client construction or network: one independent signature.
      expect(twilio.validateRequest(binding.secret, signature, externalUrl, fields)).toBe(true);
      expect(
        twilio.validateRequest(binding.secret, signature, externalUrl.split('?')[0]!, fields),
      ).toBe(false);
      expect(
        twilio.validateRequest(
          binding.secret,
          signature,
          externalUrl + '?' + externalUrl.split('?')[1],
          fields,
        ),
      ).toBe(false);
      const host = createFakeCarrierHostPorts({ bindings: { b1: binding }, verifyUrlSecret: true });
      const gateway = new MediaGateway(
        {
          authenticateSessionRoute: vi.fn(),
          resolveSessionRoute: vi.fn(),
          bindCarrierCallId: vi.fn(),
          recordCarrierCallIdMismatch: vi.fn(),
        },
        {
          publicBaseUrl: publicBase,
          workerToken: 'synthetic-worker-token',
          ingresses: loaded.ingress ? [loaded.ingress] : [],
          hostFor: () => host,
        },
      );
      try {
        const { port } = await gateway.listen();
        for (const candidate of [
          signature,
          undefined,
          'invalid',
          sign(externalUrl.split('?')[0]!, fields),
        ]) {
          const response = await fetch(
            new Request(`http://127.0.0.1:${port}${callbackPath}`, {
              method: 'POST',
              headers: candidate ? { 'x-twilio-signature': candidate } : {},
              body: new URLSearchParams(fields),
            }),
          );
          expect(response.status).toBe(candidate === signature ? 204 : 403);
        }
        expect(host.events).toHaveLength(1);
        expect(host.events[0]).toMatchObject({
          carrierId: 'twilio',
          bindingId: 'b1',
          carrierCallId: fields.CallSid,
          dialRequestId: 'dial-1',
          state: 'completed',
        });
        expect(sentinel.attempts).toEqual([]);
      } finally {
        await gateway.close();
        await loaded.graph.dispose();
      }
    },
    { allowLoopback: true },
  );
});

it('selects the installed carrier from release.selections, dials FixtureNet, and carries real Twilio frames through C2 to WorkerMediaLink', async () => {
  await withEgressSentinel(
    async (sentinel) => {
      const loaded = await installed();
      const server = createServer((_req, res) => res.writeHead(200).end());
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('loopback worker has no port');
      const route: DurableMediaRoute = {
        sessionId: 's1',
        jobId: 'j1',
        organizationId: 'w1',
        workerId: 'worker',
        workerEndpoint: `ws://127.0.0.1:${address.port}/internal/media`,
        ownerEpoch: 7,
        generation: 2,
        carrierId: loaded.selected.carrierId,
        bindingId: 'b1',
        carrierCallId: fields.CallSid,
        status: 'accepted',
      };
      const audio: number[][] = [],
        digits: string[] = [],
        played: string[] = [];
      let link: WorkerMediaLink | undefined;
      const detach = attachWorkerMediaServer({
        httpServer: server,
        token: 'synthetic-worker-token',
        async onOpen(open, socket, handoff) {
          expect(open).toMatchObject({
            carrierId: loaded.selected.carrierId,
            sessionId: 's1',
            routeToken: 'rt1',
            playbackEvidence: 'carrier-played',
            clearFlushesMarkers: true,
          });
          link = new WorkerMediaLink(open, socket);
          link.onAudio((bytes) => audio.push([...bytes]));
          link.onDtmf((digit) => digits.push(digit));
          link.onPlayed((name) => played.push(name));
          handoff();
          socket.send(JSON.stringify({ type: 'session.accept' }));
          link.activate();
        },
      });
      const host = createFakeCarrierHostPorts({
        bindings: { b1: binding },
        verifyUrlSecret: true,
        resumeStream: { kind: 'ended' },
      });
      const gateway = new MediaGateway(
        {
          authenticateSessionRoute: async (sid, rt) =>
            sid === 's1' && rt === 'rt1' ? route : undefined,
          resolveSessionRoute: async () => route,
          bindCarrierCallId: async () => ({ kind: 'conflict' }),
          recordCarrierCallIdMismatch: async () => undefined,
        },
        {
          publicBaseUrl: publicBase,
          workerToken: 'synthetic-worker-token',
          ingresses: loaded.ingress ? [loaded.ingress] : [],
          hostFor: () => host,
        },
      );
      const sockets: WebSocket[] = [];
      try {
        const { port } = await gateway.listen();
        const mediaUrl = `${publicBase.replace('https:', 'wss:')}/carriers/twilio/b1/media`;
        const resumeUrl = `${publicBase}/carriers/twilio/b1/resume?r=dial-1&t=token`;
        expect(loaded.selected.capabilities.control.maxDuration).toBe(true);
        const result = await loaded.selected.control.create(loaded.selected.binding).dial({
          requestId: 'dial-1',
          jobId: 'j1',
          to: '+15550123',
          from: '+15550456',
          media: { url: mediaUrl, routeParams: { sid: 's1', rt: 'rt1' }, format: MULAW_8K },
          callbacks: {
            status: `${publicBase}/status`,
            answer: `${publicBase}/answer`,
            resume: resumeUrl,
          },
          maxDurationSec: 60,
        });
        expect(result).toMatchObject({ kind: 'accepted', carrierCallId: fields.CallSid });
        loaded.net.assertComplete();
        const markup = new URLSearchParams(loaded.net.log[0]!.data as string).get('Twiml')!;
        expect(markup).toContain(`<Stream url="${mediaUrl}">`);
        expect(markup).toContain('<Parameter name="sid" value="s1"/>');
        expect(markup).toContain('<Parameter name="rt" value="rt1"/>');
        expect(markup).toContain('<Redirect method="POST">');
        const connect = (signature?: string) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/carriers/twilio/b1/media`, {
            headers: signature ? { 'x-twilio-signature': signature } : {},
          });
          sockets.push(socket);
          return socket;
        };
        for (const signature of [undefined, 'wrong', sign(mediaUrl.replace('wss:', 'https:'))])
          await expect(once(connect(signature), 'open')).rejects.toThrow(
            'Unexpected server response: 403',
          );
        const start = (customParameters: Record<string, string>, callSid = fields.CallSid) =>
          JSON.stringify({
            event: 'start',
            sequenceNumber: '1',
            streamSid: 'MZfixture',
            start: {
              streamSid: 'MZfixture',
              callSid,
              accountSid: binding.config.accountSid,
              tracks: ['inbound'],
              mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
              customParameters,
            },
          });
        for (const [params, call] of [
          [{}, fields.CallSid],
          [{ sid: 's1', rt: 'wrong' }, fields.CallSid],
          [{ sid: 's1', rt: 'rt1' }, 'CAwrong'],
        ] as const) {
          const denied = connect(sign(mediaUrl));
          await once(denied, 'open');
          const closed = once(denied, 'close');
          denied.send(start(params, call));
          await closed;
          expect(link).toBeUndefined();
        }
        const socket = connect(sign(mediaUrl));
        await once(socket, 'open');
        const frames: Record<string, any>[] = [];
        socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
        socket.send(start({ sid: 's1', rt: 'rt1' }));
        await vi.waitFor(() => expect(link).toBeDefined());
        socket.send(
          JSON.stringify({
            event: 'media',
            sequenceNumber: '2',
            streamSid: 'MZfixture',
            media: { track: 'inbound', chunk: '1', timestamp: '20', payload: 'AQID' },
          }),
        );
        socket.send(
          JSON.stringify({
            event: 'dtmf',
            sequenceNumber: '3',
            streamSid: 'MZfixture',
            dtmf: { track: 'inbound_track', digit: '7' },
          }),
        );
        await vi.waitFor(() => expect(audio).toEqual([[1, 2, 3]]));
        expect(digits).toEqual(['7']);
        await link!.sendAudio(Uint8Array.of(4, 5));
        await link!.mark('proof');
        await link!.clear();
        await vi.waitFor(() =>
          expect(frames.map((frame) => frame.event)).toEqual(['media', 'mark', 'clear']),
        );
        expect(frames[0]).toMatchObject({ streamSid: 'MZfixture', media: { payload: 'BAU=' } });
        socket.send(
          JSON.stringify({
            event: 'mark',
            sequenceNumber: '4',
            streamSid: 'MZfixture',
            mark: { name: 'proof' },
          }),
        );
        await vi.waitFor(() => expect(played).toEqual(['proof']));
        const closed = once(socket, 'close');
        await link!.terminate('behavior_completed');
        expect((await closed)[0]).toBe(1000);
        expect(frames).toHaveLength(3);
        const resumeFields = { CallSid: fields.CallSid };
        const resumed = await fetch(
          new Request(
            `http://127.0.0.1:${port}${new URL(resumeUrl).pathname}${new URL(resumeUrl).search}`,
            {
              method: 'POST',
              headers: { 'x-twilio-signature': sign(resumeUrl, resumeFields) },
              body: new URLSearchParams(resumeFields),
            },
          ),
        );
        expect(resumed.status).toBe(200);
        expect(await resumed.text()).toBe('<Response><Hangup/></Response>');
        expect(sentinel.attempts).toEqual([]);
      } finally {
        link?.finish('test cleanup');
        for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.terminate();
        await gateway.close();
        await detach();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await loaded.graph.dispose();
      }
    },
    { allowLoopback: true },
  );
});
