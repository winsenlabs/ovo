import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import type { CarrierHostPorts, CarrierHttpRoute } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import {
  TwilioTelephonyControl,
  twilioControlFactory,
  twilioIngress,
  twilioSignature,
} from '../src/index.ts';

// OBS-4: every refusal below used to be a bare status code with no log line naming its cause.

const sid = 'AC00000000000000000000000000000000';
const callSid = 'CA00000000000000000000000000000000';
const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  workspaceId: 'w1',
  config: { accountSid: sid },
  secret: 'fixture-auth-token',
};

let lines: Record<string, unknown>[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    lines.push(JSON.parse(line));
  });
});
afterEach(() => vi.restoreAllMocks());
const logged = (event: string) => lines.find((line) => line.event === event);

function signedRequest(
  host: ReturnType<typeof createFakeCarrierHostPorts>,
  purpose: CarrierHttpRoute['purpose'],
  fields: Record<string, string>,
  rewrite: (url: string) => string = (url) => url,
) {
  const url = rewrite(
    host.callbackUrl(
      'twilio',
      'b1',
      purpose,
      purpose === 'inbound' ? undefined : { requestId: 'r1' },
    ),
  );
  return {
    method: 'POST' as const,
    externalUrl: url,
    bindingId: 'b1',
    query: Object.fromEntries(new URL(url).searchParams),
    rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
    headers: { 'x-twilio-signature': twilioSignature(binding.secret, url, fields) },
  };
}

const handler = (purpose: CarrierHttpRoute['purpose']) =>
  twilioIngress.routes.find((route) => route.purpose === purpose)!;

function failing(host: CarrierHostPorts, method: keyof CarrierHostPorts, result: () => unknown) {
  return new Proxy(host, {
    get: (target, key) => (key === method ? async () => result() : Reflect.get(target, key)),
  }) as CarrierHostPorts;
}

it('logs the host-port cause behind a 503 callback reply', async () => {
  const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
  const request = signedRequest(host, 'status', {
    CallSid: callSid,
    CallStatus: 'completed',
    SequenceNumber: '3',
  });
  const broken = failing(host, 'applyCallEvent', () => {
    throw new Error('callback store unavailable');
  });
  expect((await handler('status').handle(request, broken)).status).toBe(503);
  expect(logged('twilio_callback_failed')).toMatchObject({
    level: 'error',
    component: 'carrier-twilio',
    purpose: 'status',
    bindingId: 'b1',
    status: 503,
    error: 'Twilio host port failed',
    cause: 'callback store unavailable',
  });
});

it('logs a 403 with the failed check and call, never the auth token or URL secret', async () => {
  const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
  const fields = { CallSid: callSid, CallStatus: 'completed', SequenceNumber: '3' };
  const forged = { ...signedRequest(host, 'status', fields), headers: {} };
  expect((await handler('status').handle(forged, host)).status).toBe(403);
  expect(logged('twilio_callback_unauthenticated')).toMatchObject({
    level: 'warn',
    purpose: 'status',
    check: 'signature',
    carrierCallId: callSid,
    signaturePresent: false,
  });
  lines = [];
  const wrongSecret = signedRequest(host, 'status', fields, (url) =>
    url.replace(/([?&]t=)[^&]+/, '$1not-the-secret'),
  );
  expect((await handler('status').handle(wrongSecret, host)).status).toBe(403);
  expect(logged('twilio_callback_unauthenticated')).toMatchObject({ check: 'url-secret' });
  expect(JSON.stringify(lines)).not.toMatch(/fixture-auth-token|not-the-secret/);
});

it('logs an unmapped call status and an unmatched callback', async () => {
  const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
  const unknown = signedRequest(host, 'status', {
    CallSid: callSid,
    CallStatus: 'teleported',
    SequenceNumber: '1',
  });
  expect((await handler('status').handle(unknown, host)).status).toBe(400);
  expect(logged('twilio_status_unmapped')).toMatchObject({
    carrierCallId: callSid,
    callStatus: 'teleported',
  });
  const known = signedRequest(host, 'status', {
    CallSid: callSid,
    CallStatus: 'completed',
    SequenceNumber: '2',
  });
  const unmatched = failing(host, 'applyCallEvent', () => ({ kind: 'unmatched' }));
  expect((await handler('status').handle(known, unmatched)).status).toBe(404);
  expect(logged('twilio_callback_unmatched')).toMatchObject({
    carrierCallId: callSid,
    kind: 'unmatched',
  });
});

it('logs why reconcile is still pending instead of returning pending silently', async () => {
  const net = createFixtureNet([
    {
      host: 'api.twilio.com',
      source: 'https://www.twilio.com/docs/voice/api/call-resource',
      retrieved: '2026-10-05',
      steps: [
        {
          expect: 'http',
          method: 'GET',
          url: `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`,
          reply: { status: 401, body: JSON.stringify({ code: 20003 }) },
        },
      ],
    },
  ]);
  const control = twilioControlFactory(net).create(binding);
  expect(await control.reconcile({ requestId: 'r1', carrierCallId: callSid })).toEqual({
    kind: 'pending',
  });
  expect(logged('twilio_reconcile_pending')).toMatchObject({
    requestId: 'r1',
    carrierCallId: callSid,
    bindingId: 'b1',
    status: 401,
  });
  expect(JSON.stringify(lines)).not.toContain('fixture-auth-token');
});

// The legacy v1 adapter's own pending path had no test, so its log line could vanish unnoticed.
it('logs why the legacy adapter’s reconcile is still pending', async () => {
  const control = new TwilioTelephonyControl(
    { accountSid: sid, authToken: 'legacy-auth-token' },
    {
      findCarrierCallId: async () => callSid,
    },
    {
      createCall: async () => ({ sid: callSid }),
      updateCall: async () => undefined,
      fetchCall: async () => {
        throw Object.assign(new Error('Twilio REST 503'), { status: 503 });
      },
    },
  );
  expect(await control.reconcile('r-legacy')).toEqual({ kind: 'pending' });
  expect(logged('twilio_reconcile_pending')).toMatchObject({
    level: 'warn',
    requestId: 'r-legacy',
    carrierCallId: callSid,
    error: 'Twilio REST 503',
  });
  expect(JSON.stringify(lines)).not.toContain('legacy-auth-token');
});
