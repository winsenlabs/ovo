import { createFakeCarrierHostPorts, fakeBinding } from '@winsendotai/ovo-conformance';
import type { CarrierHostPorts, CarrierHttpRoute } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { createSipRequestVerifier, createSipRoutes, mapSipCallState } from '../src/index.ts';
import { signedSipHttpRequest } from '../src/testing.ts';

const key = new Uint8Array(32).fill(5);
const now = 1_760_000_000_000;
const binding = fakeBinding({
  pluginId: '@winsendotai/ovo-carrier-sip',
  config: { trunkId: 't1' },
});
const routes = (options: Partial<Parameters<typeof createSipRoutes>[0]> = {}) =>
  createSipRoutes({
    carrierId: 'sip',
    verifier: () => createSipRequestVerifier({ keys: [key], now: () => now }),
    ...options,
  });
const routeOf = (list: CarrierHttpRoute[], purpose: CarrierHttpRoute['purpose']) =>
  list.find((route) => route.purpose === purpose)!;
const host = () => createFakeCarrierHostPorts({ bindings: { b1: binding } });

const inboundBody = {
  v: 1,
  callId: 'a84b4c76e66710@pc33.example',
  trunkId: 't1',
  from: '+919876543210',
  to: '+918041234567',
  receivedAt: '2026-10-13T10:00:00.000Z',
  headers: { 'X-Example-Account': '12345' },
  sip: {
    requestUri: 'sip:+918041234567@203.0.113.10',
    fromUri: 'sip:+919876543210@198.51.100.7',
  },
  retry: 0,
};
const inbound = (body: unknown = inboundBody, extra = {}) =>
  signedSipHttpRequest({
    key,
    carrierId: 'sip',
    bindingId: 'b1',
    purpose: 'inbound',
    body,
    now,
    ...extra,
  });
const statusBody = {
  v: 1,
  eventId: 'c-1:completed',
  callId: 'c-1',
  dialRequestId: 'req-42',
  state: 'completed',
  occurredAt: '2026-10-13T10:03:12.000Z',
  sipCode: 200,
  reason: 'Q.850;cause=16',
  payload: { endReason: 'remote_bye', durationMs: 182000 },
};
const callbackQuery = (ports: CarrierHostPorts, purpose: 'status' | 'resume', requestId: string) =>
  Object.fromEntries(new URL(ports.callbackUrl('sip', 'b1', purpose, { requestId })).searchParams);

describe('SIP carrier routes (§5.2)', () => {
  it('admits an inbound call with raw SIP fields and fills its callbacks', async () => {
    const ports = host();
    const reply = await routeOf(routes({ forwardHeaderPrefix: 'acme.' }), 'inbound').handle(
      await inbound(),
      ports,
    );
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe('application/json');
    const admission = ports.calls.find((call) => call.method === 'admitInbound')!.args;
    expect(admission).toMatchObject({
      carrierId: 'sip',
      bindingId: 'b1',
      carrierCallId: inboundBody.callId,
      from: '+919876543210',
      to: '+918041234567',
      receivedAt: new Date(inboundBody.receivedAt),
      raw: {
        'sip.callId': inboundBody.callId,
        'sip.trunkId': 't1',
        'sip.header.X-Example-Account': '12345',
        'acme.x-example-account': '12345',
      },
    });
    const decision = JSON.parse(reply.body);
    expect(decision.kind).toBe('connect');
    expect(decision.statusUrl).toBe(
      ports.callbackUrl('sip', 'b1', 'status', { requestId: inboundBody.callId }),
    );
    expect(decision.resumeUrl).toBe(
      ports.callbackUrl('sip', 'b1', 'resume', { requestId: inboundBody.callId }),
    );
  });

  it('returns non-connect decisions verbatim', async () => {
    const ports = createFakeCarrierHostPorts({
      bindings: { b1: binding },
      admitInbound: { kind: 'busy', reason: 'at_capacity' },
    });
    const reply = await routeOf(routes(), 'inbound').handle(await inbound(), ports);
    expect(JSON.parse(reply.body)).toEqual({ kind: 'busy', reason: 'at_capacity' });
  });

  it('answers 503 without the verifier capability, before reading anything', async () => {
    const reply = await routeOf(routes({ verifier: () => undefined }), 'inbound').handle(
      await inbound(),
      host(),
    );
    expect(reply).toMatchObject({ status: 503 });
    expect(JSON.parse(reply.body)).toEqual({ error: 'sip_trunk_unavailable' });
  });

  it('refuses a bad signature with 401 and a bad url-secret with 403', async () => {
    const forged = await signedSipHttpRequest({
      key: new Uint8Array(32),
      carrierId: 'sip',
      bindingId: 'b1',
      purpose: 'inbound',
      body: inboundBody,
      now,
    });
    expect((await routeOf(routes(), 'inbound').handle(forged, host())).status).toBe(401);
    const ports = host();
    ports.setVerifyUrlSecret(false);
    const queried = await inbound(inboundBody, { query: { t: 'nope' } });
    expect((await routeOf(routes(), 'inbound').handle(queried, ports)).status).toBe(403);
  });

  it.each([
    ['a non-E.164 to', { ...inboundBody, to: '08041234567' }],
    ['a wrong version', { ...inboundBody, v: 2 }],
    ['an unknown field', { ...inboundBody, extra: true }],
    [
      '17 forwarded headers',
      {
        ...inboundBody,
        headers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`X-H${i}`, 'v'])),
      },
    ],
  ])('answers 400 for %s', async (_label, body) => {
    expect((await routeOf(routes(), 'inbound').handle(await inbound(body), host())).status).toBe(
      400,
    );
  });

  it('accepts an anonymous caller', async () => {
    const ports = host();
    const reply = await routeOf(routes(), 'inbound').handle(
      await inbound({ ...inboundBody, from: 'anonymous' }),
      ports,
    );
    expect(reply.status).toBe(200);
  });

  it('answers 503 when a host port fails', async () => {
    const ports = { ...host(), admitInbound: async () => Promise.reject(new Error('db down')) };
    expect((await routeOf(routes(), 'inbound').handle(await inbound(), ports)).status).toBe(503);
  });

  it('normalises a status callback into one call event', async () => {
    const ports = host();
    const request = await signedSipHttpRequest({
      key,
      carrierId: 'sip',
      bindingId: 'b1',
      purpose: 'status',
      body: statusBody,
      query: callbackQuery(ports, 'status', 'req-42'),
      now,
    });
    const reply = await routeOf(routes(), 'status').handle(request, ports);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ result: 'applied' });
    expect(ports.events).toEqual([
      {
        carrierId: 'sip',
        bindingId: 'b1',
        eventId: 'c-1:completed',
        carrierCallId: 'c-1',
        carrierRequestId: 'req-42',
        dialRequestId: 'req-42',
        state: 'completed',
        occurredAt: new Date('2026-10-13T10:03:12.000Z'),
        payload: {
          endReason: 'remote_bye',
          durationMs: 182000,
          sipCode: 200,
          reason: 'Q.850;cause=16',
        },
      },
    ]);
    expect(ports.calls.find((c) => c.method === 'verifyUrlSecret')!.args).toEqual({
      purpose: 'status',
      requestId: 'req-42',
    });
  });

  it('refuses a status outside CallState', async () => {
    const request = await signedSipHttpRequest({
      key,
      carrierId: 'sip',
      bindingId: 'b1',
      purpose: 'status',
      body: { ...statusBody, state: 'queued' },
      now,
    });
    expect((await routeOf(routes(), 'status').handle(request, host())).status).toBe(400);
    expect(mapSipCallState('queued')).toBeUndefined();
    expect(mapSipCallState('no_answer')).toBe('no_answer');
  });

  it('re-issues a stream on resume, or says ended', async () => {
    const mediaUrl = 'wss://ovo.example.test/carriers/sip/b1/media';
    const ports = createFakeCarrierHostPorts({
      bindings: { b1: binding },
      resumeStream: { kind: 'stream', mediaUrl, routeParams: { sid: 's-2', rt: 'rt-2' } },
    });
    const request = await signedSipHttpRequest({
      key,
      carrierId: 'sip',
      bindingId: 'b1',
      purpose: 'resume',
      body: { v: 1, callId: 'c-1' },
      query: callbackQuery(ports, 'resume', 'c-1'),
      now,
    });
    const reply = JSON.parse((await routeOf(routes(), 'resume').handle(request, ports)).body);
    expect(reply).toMatchObject({
      kind: 'stream',
      mediaUrl,
      routeParams: { sid: 's-2', rt: 'rt-2' },
    });
    expect(reply.resumeUrl).toContain('/carriers/sip/b1/resume?r=c-1');
    const ended = await routeOf(routes(), 'resume').handle(request, host());
    expect(JSON.parse(ended.body)).toEqual({ kind: 'ended' });
  });
});
