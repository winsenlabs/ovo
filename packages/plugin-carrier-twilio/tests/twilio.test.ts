import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import {
  MULAW_8K,
  type CarrierHostPorts,
  type DialRequest,
  type NetFixtureScript,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import {
  createTwilioFixtureFrameEncoder,
  twilioControlFactory,
  twilioIngress,
  twilioMediaSerializer,
  twilioSignature,
  validateTwilioSignature,
} from '../src/index.ts';

const sid = 'AC00000000000000000000000000000000';
const callSid = 'CA00000000000000000000000000000000';
const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  workspaceId: 'w1',
  config: { accountSid: sid },
  secret: 'fixture-token',
};
const rest = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls`;
const fixture = (
  method: string,
  url: string,
  status: number,
  body: unknown,
): NetFixtureScript[] => [
  {
    host: 'api.twilio.com',
    source: 'https://www.twilio.com/docs/voice/api/call-resource',
    retrieved: '2026-09-22',
    steps: [
      {
        expect: 'http',
        method,
        url,
        ...(method === 'POST' ? { body: 'form' as const } : {}),
        reply: { status, body: JSON.stringify(body) },
      },
    ],
  },
];
const dialRequest: DialRequest = {
  requestId: 'req-1',
  jobId: 'job-1',
  to: '+15550123',
  from: '+15550456',
  media: {
    url: 'wss://voice.example.test/carriers/twilio/b1/media',
    routeParams: { sid: 'session-1', rt: 'token-1' },
    format: MULAW_8K,
  },
  callbacks: {
    status: 'https://voice.example.test/status?r=req-1&t=secret',
    answer: 'https://voice.example.test/answer',
    amd: 'https://voice.example.test/amd',
    resume: 'https://voice.example.test/resume',
  },
  amd: { mode: 'detect' },
  ringTimeoutSec: 25,
  maxDurationSec: 420,
};

describe('Twilio v2 control', () => {
  it('sends complete dial fields and never dials an https/query Stream URL', async () => {
    const net = createFixtureNet(fixture('POST', `${rest}.json`, 201, { sid: callSid }));
    const control = twilioControlFactory(net).create(binding);
    for (const mediaUrl of [
      'https://voice.example.test/media',
      `${dialRequest.media.url}?edge=1`,
    ]) {
      expect(
        await control.dial({ ...dialRequest, media: { ...dialRequest.media, url: mediaUrl } }),
      ).toMatchObject({ kind: 'rejected', retryable: false });
    }
    expect(net.log).toHaveLength(0);
    expect(await control.dial(dialRequest)).toMatchObject({
      kind: 'accepted',
      carrierCallId: callSid,
    });
    net.assertComplete();
    const body = new URLSearchParams(net.log[0]?.data as string);
    expect(Object.fromEntries(body)).toMatchObject({
      TimeLimit: '420',
      Timeout: '25',
      MachineDetection: 'DetectMessageEnd',
      AsyncAmd: 'true',
      AsyncAmdStatusCallback: dialRequest.callbacks.amd,
      StatusCallbackMethod: 'POST',
    });
    expect(body.getAll('StatusCallbackEvent')).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);
    expect(body.get('Twiml')).toContain(
      '<Redirect method="POST">https://voice.example.test/resume</Redirect>',
    );
    expect(body.get('Twiml')).toContain('<Parameter name="sid" value="session-1"/>');
  });

  it.each([
    ['queued', 'live', 'queued'],
    ['initiated', 'live', 'ringing'],
    ['ringing', 'live', 'ringing'],
    ['in-progress', 'live', 'in_progress'],
    ['completed', 'ended', 'completed'],
    ['busy', 'ended', 'busy'],
    ['no-answer', 'ended', 'no_answer'],
    ['failed', 'ended', 'failed'],
    ['canceled', 'ended', 'canceled'],
  ])('reconciles %s to %s/%s', async (status, kind, state) => {
    const net = createFixtureNet(
      fixture('GET', `${rest}/${callSid}.json`, 200, { sid: callSid, status }),
    );
    expect(
      await twilioControlFactory(net)
        .create(binding)
        .reconcile({ requestId: 'req-1', carrierCallId: callSid }),
    ).toMatchObject({ kind, state });
    net.assertComplete();
  });

  it('treats a 404 hangup as already ended and request-id-only as unsupported', async () => {
    const net = createFixtureNet(fixture('POST', `${rest}/${callSid}.json`, 404, { code: 20404 }));
    const control = twilioControlFactory(net).create(binding);
    expect(await control.hangup({ carrierRequestId: 'req-1' })).toBe('unsupported');
    expect(net.log).toHaveLength(0);
    expect(await control.hangup({ carrierCallId: callSid })).toBe('already_ended');
    net.assertComplete();
  });

  it('fails closed on resume handoff when the binding has no callback URL', async () => {
    const net = createFixtureNet([]);
    expect(
      await twilioControlFactory(net).create(binding).handoff(callSid, { kind: 'resume' }, 'req-1'),
    ).toMatchObject({
      kind: 'rejected',
      retryable: false,
      reason: 'Twilio resume URL is unavailable',
    });
    expect(net.log).toHaveLength(0);
  });
});

describe('Twilio auth and codec', () => {
  it('rejects changed scheme, host, parameter order, and body', () => {
    const target = 'https://voice.example.test/status?r=req-1';
    const params = { To: '+15550100', From: '+15550199' };
    const signature = twilioSignature(binding.secret, target, params);
    expect(
      validateTwilioSignature({
        authToken: binding.secret,
        signature,
        externalUrl: target,
        parameters: params,
      }),
    ).toBe(true);
    for (const changed of [target.replace('https:', 'http:'), target.replace('voice.', 'evil.')])
      expect(
        validateTwilioSignature({
          authToken: binding.secret,
          signature,
          externalUrl: changed,
          parameters: params,
        }),
      ).toBe(false);
    expect(
      validateTwilioSignature({
        authToken: binding.secret,
        signature,
        externalUrl: target,
        parameters: { ...params, To: '+15550101' },
      }),
    ).toBe(false);
    const wronglyOrdered = createHmac('sha1', binding.secret)
      .update(target + 'To+15550100From+15550199')
      .digest('base64');
    expect(
      validateTwilioSignature({
        authToken: binding.secret,
        signature: wronglyOrdered,
        externalUrl: target,
        parameters: params,
      }),
    ).toBe(false);
    expect(
      validateTwilioSignature({
        authToken: binding.secret,
        signature: '',
        externalUrl: target,
        parameters: params,
      }),
    ).toBe(false);
    expect(
      validateTwilioSignature({
        authToken: binding.secret,
        signature: 'a'.repeat(100),
        externalUrl: target,
        parameters: params,
      }),
    ).toBe(false);
  });

  it('chunks outbound audio at 8 KiB and round-trips the session-scoped fixture encoder', () => {
    const encoder = createTwilioFixtureFrameEncoder();
    const codec = twilioMediaSerializer.createSession({});
    expect(codec.decode(encoder({ type: 'connected' }))).toEqual([{ type: 'connected' }]);
    const started = codec.decode(
      encoder({
        type: 'start',
        carrierCallId: callSid,
        streamId: 'MZspecific',
        format: MULAW_8K,
        routeParams: { sid: 'session-1', rt: 'token-1' },
      }),
    );
    expect(started[0]).toMatchObject({
      type: 'start',
      streamId: 'MZspecific',
      carrierCallId: callSid,
    });
    const payload = new Uint8Array(16_385).fill(0xff);
    const frames = codec.encode({ type: 'audio', payload });
    expect(frames).toHaveLength(3);
    expect(
      frames.map(
        (frame) =>
          Buffer.from((JSON.parse(frame) as { media: { payload: string } }).media.payload, 'base64')
            .length,
      ),
    ).toEqual([8192, 8192, 1]);
    expect(
      codec.decode(
        encoder({ type: 'audio', seq: 2, timestampMs: 17, payload: new Uint8Array([1, 2]) }),
      )[0],
    ).toMatchObject({ type: 'audio', timestampMs: 17, payload: new Uint8Array([1, 2]) });
    expect(codec.decode(encoder({ type: 'stop', reason: 'stream-ended' }))).toEqual([
      { type: 'stop', reason: 'stream-ended' },
    ]);
  });

  it('refuses a cross-stream or replayed inbound frame', () => {
    const encoder = createTwilioFixtureFrameEncoder();
    const codec = twilioMediaSerializer.createSession({});
    codec.decode(
      encoder({
        type: 'start',
        carrierCallId: callSid,
        streamId: 'MZowned',
        format: MULAW_8K,
        routeParams: { sid: 's1', rt: 't1' },
      }),
    );
    const audio = encoder({ type: 'audio', seq: 2, timestampMs: 1, payload: new Uint8Array([1]) });
    const changed = JSON.stringify({
      ...(JSON.parse(audio) as Record<string, unknown>),
      streamSid: 'MZother',
    });
    expect(() => codec.decode(changed)).toThrow(/does not match the started stream/);
    expect(() => codec.decode(audio)).toThrow(/duplicate or out of order/);
  });

  it('rejects bad signed status and inbound requests before host state changes', async () => {
    const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
    for (const purpose of ['inbound', 'status'] as const) {
      const route = twilioIngress.routes.find((item) => item.purpose === purpose)!;
      const url = host.callbackUrl(
        'twilio',
        'b1',
        purpose,
        purpose === 'status' ? { requestId: 'req-1' } : undefined,
      );
      const fields: Record<string, string> =
        purpose === 'status'
          ? { CallSid: callSid, CallStatus: 'completed', SequenceNumber: '3' }
          : {
              CallSid: callSid,
              AccountSid: sid,
              From: '+15550123',
              To: '+15550456',
              Direction: 'inbound',
            };
      const result = await route.handle(
        {
          method: 'POST',
          externalUrl: url,
          bindingId: 'b1',
          query: Object.fromEntries(new URL(url).searchParams),
          rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
          headers: { 'x-twilio-signature': 'bad' },
        },
        host,
      );
      expect(result.status).toBe(403);
    }
    expect(host.events).toHaveLength(0);
    expect(host.calls.some((entry) => entry.method === 'admitInbound')).toBe(false);
  });

  it.each([
    [
      'inbound',
      'admitInbound',
      {
        CallSid: callSid,
        AccountSid: sid,
        From: '+15550123',
        To: '+15550456',
        Direction: 'inbound',
      },
    ],
    [
      'status',
      'applyCallEvent',
      { CallSid: callSid, CallStatus: 'completed', SequenceNumber: '3' },
    ],
    ['amd', 'applyCallEvent', { CallSid: callSid, AnsweredBy: 'machine_start' }],
    ['resume', 'resumeStream', { CallSid: callSid }],
  ] as const)('returns 503 when signed %s host %s fails', async (purpose, method, fields) => {
    const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
    const url = host.callbackUrl(
      'twilio',
      'b1',
      purpose,
      purpose === 'inbound' ? undefined : { requestId: 'req-1' },
    );
    const request = {
      method: 'POST' as const,
      externalUrl: url,
      bindingId: 'b1',
      query: Object.fromEntries(new URL(url).searchParams),
      rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
      headers: { 'x-twilio-signature': twilioSignature(binding.secret, url, fields) },
    };
    const failingHost = new Proxy(host, {
      get(target, key) {
        return key === method
          ? async () => {
              throw new Error('host storage unavailable');
            }
          : Reflect.get(target, key);
      },
    }) as CarrierHostPorts;
    const route = twilioIngress.routes.find((item) => item.purpose === purpose)!;
    expect((await route.handle(request, failingHost)).status).toBe(503);
  });

  it('keeps malformed signed callback fields at 400 and an unavailable binding port at 503', async () => {
    const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
    const route = twilioIngress.routes.find((item) => item.purpose === 'inbound')!;
    const url = host.callbackUrl('twilio', 'b1', 'inbound');
    const fields = { CallSid: callSid, AccountSid: sid, From: '+15550123', To: '+15550456' };
    const request = {
      method: 'POST' as const,
      externalUrl: url,
      bindingId: 'b1',
      query: Object.fromEntries(new URL(url).searchParams),
      rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
      headers: { 'x-twilio-signature': twilioSignature(binding.secret, url, fields) },
    };
    expect((await route.handle(request, host)).status).toBe(400);
    const failingHost = new Proxy(host, {
      get(target, key) {
        return key === 'resolveBinding'
          ? async () => {
              throw new Error('secret store unavailable');
            }
          : Reflect.get(target, key);
      },
    }) as CarrierHostPorts;
    expect((await route.handle(request, failingHost)).status).toBe(503);
  });
});
