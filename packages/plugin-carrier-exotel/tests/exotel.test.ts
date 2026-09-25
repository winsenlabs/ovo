import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import { compileConfigSchema } from '@winsendotai/ovo-runtime';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import {
  exotelCarrierPlugin,
  exotelControlFactory,
  exotelIngress,
  exotelMediaSerializer,
  exotelRoutes,
} from '../src/index.ts';
import { basicAuthorization, inCidr } from '../src/signature.ts';

const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-exotel',
  workspaceId: 'w1',
  config: {
    accountSid: 'exotel-account',
    apiKey: 'key',
    exophone: '0XXXXXX4890',
    appId: 'flow-1',
    region: 'in',
    streamEndTerminatesCall: true,
  },
  secret: 'token',
};
const start = (sampleRate = '8000') =>
  JSON.stringify({
    event: 'start',
    stream_sid: 'stream-1',
    start: {
      stream_sid: 'stream-1',
      call_sid: 'call-1',
      account_sid: 'exotel-account',
      from: '+919876543210',
      to: '+911234567890',
      custom_parameters: { sid: 'custom-session', rt: 'custom-route' },
      media_format: { encoding: 'raw', sample_rate: sampleRate, bit_rate: '128' },
    },
  });
describe('Exotel media protocol', () => {
  it('decodes 16 kHz, uses custom parameters over URL fallback, and maps stop reasons', () => {
    const codec = exotelMediaSerializer.createSession({ sid: 'url-session', rt: 'url-route' });
    expect(codec.decode(start('16000'))[0]).toMatchObject({
      format: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 },
      routeParams: { sid: 'custom-session', rt: 'custom-route' },
    });
    expect(
      codec.decode(
        JSON.stringify({
          event: 'stop',
          stream_sid: 'stream-1',
          stop: { reason: 'callended' },
        }),
      ),
    ).toEqual([{ type: 'stop', reason: 'caller-hangup' }]);
    expect(codec.terminate?.()).toEqual([]);
  });

  it('falls back to URL parameters and rejects malformed audio and stream spoofing', () => {
    const codec = exotelMediaSerializer.createSession({ sid: 'url-session', rt: 'url-route' });
    const noCustom = JSON.parse(start()) as { start: Record<string, unknown> };
    delete noCustom.start.custom_parameters;
    expect(codec.decode(JSON.stringify(noCustom))[0]).toMatchObject({
      routeParams: { sid: 'url-session', rt: 'url-route' },
    });
    expect(() =>
      codec.decode(
        JSON.stringify({
          event: 'media',
          stream_sid: 'other',
          sequence_number: 2,
          media: { chunk: 1, timestamp: '10', payload: 'AA==' },
        }),
      ),
    ).toThrow(/stream_sid/);
    expect(() =>
      codec.decode(
        JSON.stringify({
          event: 'media',
          stream_sid: 'stream-1',
          sequence_number: 2,
          media: { chunk: 1, timestamp: '10', payload: 'AA==' },
        }),
      ),
    ).toThrow(/odd bytes/);
  });

  it('fixture replay keeps the selected stream ID across frames', () => {
    const encode = exotelIngress.createFixtureFrameEncoder();
    encode({
      type: 'start',
      carrierCallId: 'call-1',
      streamId: 'selected-stream',
      format: exotelIngress.capabilities.media.formats[0]!,
      routeParams: { sid: 'session-1', rt: 'route-1' },
    });
    const frame = JSON.parse(
      encode({ type: 'audio', seq: 2, timestampMs: 10, payload: new Uint8Array([0, 1]) }),
    ) as { stream_sid: string };
    expect(frame.stream_sid).toBe('selected-stream');
  });
});

describe('Exotel authentication', () => {
  const upgrade = (headers: Record<string, string> = {}, query = '') => {
    const url = new URL(`wss://ovo.example.test/carriers/exotel/b1/media${query}`);
    return { url, externalUrl: url.origin + url.pathname, headers, remoteAddress: '198.51.100.7' };
  };
  const ctx = {
    bindingId: 'b1',
    resolveBinding: async () => binding,
    verifyUrlSecret: ({ requestId, token }: { requestId?: string; token: string | null }) =>
      requestId === 'session-1' && token === 'signed-token',
  };

  it('accepts Basic or per-call t and rejects absent credentials', async () => {
    expect(
      (
        await exotelMediaSerializer.authenticateUpgrade(
          upgrade({ Authorization: basicAuthorization('key', 'token') }),
          ctx,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await exotelMediaSerializer.authenticateUpgrade(
          upgrade({}, '?sid=session-1&rt=route-1&t=signed-token'),
          ctx,
        )
      ).ok,
    ).toBe(true);
    expect(
      await exotelMediaSerializer.authenticateUpgrade(
        upgrade({}, '?sid=session-1&rt=route-1&t=bad'),
        ctx,
      ),
    ).toEqual({ ok: false, status: 401 });
    expect((await exotelMediaSerializer.authenticateUpgrade(upgrade(), ctx)).ok).toBe(false);
  });

  it('enforces first forwarded hop against CIDR on both auth modes', async () => {
    const guarded = {
      ...ctx,
      resolveBinding: async () => ({
        ...binding,
        config: { ...binding.config, allowedCidrs: ['203.0.113.0/24'] },
      }),
    };
    expect(inCidr('203.0.113.4', '203.0.113.0/24')).toBe(true);
    expect(inCidr('203.0.114.4', '203.0.113.0/24')).toBe(false);
    expect(inCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    const basic = { authorization: basicAuthorization('key', 'token') };
    expect(
      (
        await exotelMediaSerializer.authenticateUpgrade(
          upgrade({ ...basic, 'x-forwarded-for': '198.51.100.1, 203.0.113.4' }),
          guarded,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await exotelMediaSerializer.authenticateUpgrade(
          upgrade({ ...basic, 'x-forwarded-for': '203.0.113.4, 198.51.100.1' }),
          guarded,
        )
      ).ok,
    ).toBe(true);
  });
});

describe('Exotel routes and control', () => {
  const host = () => createFakeCarrierHostPorts({ bindings: { b1: binding } });
  const request = (
    ports: ReturnType<typeof host>,
    purpose: 'media-url' | 'status',
    body: Record<string, string>,
    requestId?: string,
  ) => {
    const externalUrl = ports.callbackUrl(
      'exotel',
      'b1',
      purpose,
      requestId ? { requestId } : undefined,
    );
    return {
      method: 'POST' as const,
      bindingId: 'b1',
      externalUrl,
      query: Object.fromEntries(new URL(externalUrl).searchParams),
      headers: {},
      rawBody: new TextEncoder().encode(new URLSearchParams(body).toString()),
    };
  };
  const route = (purpose: 'media-url' | 'status') =>
    exotelRoutes.find((item) => item.purpose === purpose)!;

  it('routes outbound and inbound separately; ended and unmatched responses contain no URL', async () => {
    const outbound = host();
    const result = await route('media-url').handle(
      request(outbound, 'media-url', {
        CallSid: 'call-1',
        CustomField: 'dial-1',
        From: '+1',
        To: '+2',
      }),
      outbound,
    );
    expect(result.status).toBe(200);
    const url = new URL((JSON.parse(result.body) as { url: string }).url);
    expect(url.protocol).toBe('wss:');
    expect([...url.searchParams.keys()]).toEqual(['sid', 'rt', 't']);
    expect(url.href.length).toBeLessThanOrEqual(256);
    expect(outbound.calls.find((call) => call.method === 'streamForDial')?.args).toMatchObject({
      dialRequestId: 'dial-1',
      carrierCallId: 'call-1',
      bindingId: 'b1',
    });
    expect(outbound.calls.some((call) => call.method === 'admitInbound')).toBe(false);

    const getRoute = exotelRoutes.find(
      (route) => route.purpose === 'media-url' && route.method === 'GET',
    );
    expect(getRoute).toBeDefined();
    const getPorts = host();
    const getRequest = request(getPorts, 'media-url', {});
    const get = await getRoute!.handle(
      {
        ...getRequest,
        method: 'GET',
        rawBody: new Uint8Array(0),
        query: { ...getRequest.query, CallSid: 'call-get', CustomField: 'dial-get' },
      },
      getPorts,
    );
    expect(get.status).toBe(200);
    expect(getPorts.calls.find((call) => call.method === 'streamForDial')?.args).toMatchObject({
      dialRequestId: 'dial-get',
      carrierCallId: 'call-get',
    });

    const inbound = createFakeCarrierHostPorts({
      bindings: { b1: binding },
      streamForDial: { kind: 'unmatched' },
    });
    expect(
      (
        await route('media-url').handle(
          request(inbound, 'media-url', {
            CallSid: 'call-2',
            From: '+3',
            To: '+4',
          }),
          inbound,
        )
      ).status,
    ).toBe(200);
    expect(inbound.calls.some((call) => call.method === 'admitInbound')).toBe(true);
    const ended = createFakeCarrierHostPorts({
      bindings: { b1: binding },
      streamForDial: { kind: 'ended' },
    });
    const noUrl = await route('media-url').handle(
      request(ended, 'media-url', { CallSid: 'call-3' }),
      ended,
    );
    expect(noUrl.status).toBe(410);
    expect(noUrl.body).not.toContain('url');
    const unmatched = createFakeCarrierHostPorts({
      bindings: { b1: binding },
      streamForDial: { kind: 'unmatched' },
    });
    expect(
      (
        await route('media-url').handle(
          request(unmatched, 'media-url', {
            CallSid: 'call-4',
            CustomField: 'dial-4',
          }),
          unmatched,
        )
      ).status,
    ).toBe(404);
  });

  it('fails closed for 16 kHz selection that cannot fit the three-query URL', async () => {
    const highRate = createFakeCarrierHostPorts({
      bindings: {
        b1: {
          ...binding,
          config: { ...binding.config, sampleRate: 16000 },
        },
      },
    });
    const response = await route('media-url').handle(
      request(highRate, 'media-url', {
        CallSid: 'call-16k',
        CustomField: 'dial-16k',
      }),
      highRate,
    );
    expect(response).toMatchObject({ status: 422 });
    expect(response.body).not.toContain('"url"');
    expect(highRate.calls.some((call) => call.method === 'streamForDial')).toBe(false);
  });

  it('requires per-call url-secret before applying status', async () => {
    const ports = host();
    const valid = request(
      ports,
      'status',
      { CallSid: 'call-1', Status: 'busy', EventType: 'terminal' },
      'dial-1',
    );
    expect((await route('status').handle(valid, ports)).status).toBe(200);
    expect(ports.events).toHaveLength(1);
    expect(ports.events[0]).toMatchObject({
      carrierCallId: 'call-1',
      dialRequestId: 'dial-1',
      state: 'busy',
    });
    const tampered = { ...valid, query: { ...valid.query, t: 'bad' } };
    expect((await route('status').handle(tampered, ports)).status).toBe(401);
    const staticStatus = request(ports, 'status', { CallSid: 'call-1', Status: 'busy' });
    expect((await route('status').handle(staticStatus, ports)).status).toBe(401);
    expect(ports.events).toHaveLength(1);
  });

  it('rejects AMD before REST and maps a timeout to unknown', async () => {
    const net = createFixtureNet([]);
    const control = exotelControlFactory(net).create(binding);
    const dial = {
      requestId: 'dial-1',
      jobId: 'job-1',
      to: '+919876543210',
      from: '0XXXXXX4890',
      media: {
        url: 'wss://ovo.example.test/carriers/exotel/b1/media',
        routeParams: {},
        format: exotelIngress.capabilities.media.formats[0]!,
      },
      callbacks: {
        status: 'https://ovo.example.test/status',
        answer: 'https://ovo.example.test/answer',
      },
      maxDurationSec: 600,
    };
    expect(await control.dial({ ...dial, amd: { mode: 'detect' } })).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
    expect(net.log).toHaveLength(0);
    const highRateControl = exotelControlFactory(net).create({
      ...binding,
      config: { ...binding.config, sampleRate: 16000 },
    });
    expect(await highRateControl.dial(dial)).toMatchObject({ kind: 'rejected', retryable: false });
    const mismatched = await control.dial({
      ...dial,
      media: { ...dial.media, format: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } },
    });
    expect(mismatched).toMatchObject({ kind: 'rejected', retryable: false });
    expect(net.log).toHaveLength(0);
    const timed = exotelControlFactory(
      createFixtureNet([
        {
          host: 'api.in.exotel.com',
          source: 'https://developer.exotel.com/docs/voice-v1/api-reference/connect-to-flow',
          retrieved: '2026-09-22',
          steps: [
            {
              expect: 'http',
              method: 'POST',
              url: 'https://api.in.exotel.com/v1/Accounts/exotel-account/Calls/connect.json',
              reply: { status: 429 },
            },
          ],
        },
      ]),
    ).create(binding);
    expect(await timed.dial(dial)).toMatchObject({ kind: 'unknown', requestId: 'dial-1' });
    expect(await control.hangup({ carrierCallId: 'call-1' })).toBe('unsupported');
    expect(
      await control.handoff('call-1', { kind: 'end', message: 'bye' }, 'handoff-1'),
    ).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
  });
});

describe('Exotel manifest', () => {
  it('declares a loadable carrier and requires the stream-end attestation', () => {
    const manifest = exotelCarrierPlugin.manifest;
    expect(manifest.id).toBe('@winsendotai/ovo-carrier-exotel');
    expect(manifest.contractVersion).toBe(2);
    if (manifest.contractVersion !== 2) throw new Error('Exotel plugin is not v2');
    expect(manifest.kind).toBe('carrier');
    expect(manifest.capabilities).toMatchObject({
      media: { playbackEvidence: 'carrier-processed' },
      control: { hangup: 'close-stream', amd: 'none' },
      continuation: 'none',
    });
    const validate = compileConfigSchema(manifest.bindingSchema!);
    expect(validate({ ...binding.config, streamEndTerminatesCall: true })).toBeTruthy();
    expect(validate({ ...binding.config, streamEndTerminatesCall: false })).toBeFalsy();
    const { streamEndTerminatesCall: _attestation, ...without } = binding.config;
    expect(validate(without)).toBeFalsy();
  });
});
