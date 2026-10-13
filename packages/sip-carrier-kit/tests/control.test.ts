import type {
  DialRequest,
  ResolvedBinding,
  SipTrunkControlClient,
} from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  createSipControlFactory,
  createSipTrunkHttpClient,
  parseSipCredentials,
  sipCarrierCapabilities,
} from '../src/index.ts';

const binding: ResolvedBinding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-sip',
  workspaceId: 'w1',
  config: { trunkId: 'trunk-a', fromNumbers: ['+918000000001'] },
  secret: '{"username":"ovo","password":"pw"}',
};
const dial: DialRequest = {
  requestId: 'req-1',
  jobId: 'job-1',
  to: '+919876543210',
  from: '+918000000001',
  media: {
    url: 'wss://ovo.example.test/carriers/sip/b1/media',
    routeParams: { sid: 's', rt: 'r' },
    format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  },
  callbacks: {
    status: 'https://ovo.example.test/carriers/sip/b1/status?r=req-1&t=x',
    answer: 'https://ovo.example.test/carriers/sip/b1/answer?r=req-1&t=x',
    resume: 'https://ovo.example.test/carriers/sip/b1/resume?r=req-1&t=x',
  },
  ringTimeoutSec: 30,
  maxDurationSec: 600,
};

function scripted(replies: { status: number; body: unknown }[]) {
  const seen: Parameters<SipTrunkControlClient['request']>[0][] = [];
  const client: SipTrunkControlClient = {
    async request(input) {
      seen.push(input);
      const reply = replies.shift();
      if (!reply) throw new Error('unexpected control request');
      return reply;
    },
  };
  return { seen, client };
}
const control = (
  client: SipTrunkControlClient | undefined,
  options: {
    binding?: ResolvedBinding;
    handoff?: 'phone'[];
    dialAllowed?: () => string | undefined;
  } = {},
) =>
  createSipControlFactory({
    capabilities: sipCarrierCapabilities('sip', { handoff: options.handoff ?? [] }),
    client: () => client,
    ...(options.dialAllowed ? { dialAllowed: options.dialAllowed } : {}),
  }).create(options.binding ?? binding);

describe('SIP TelephonyControl over Cap.sipTrunkControl (§5.4)', () => {
  it('dials with the documented body and returns the Call-ID at once', async () => {
    const { seen, client } = scripted([
      {
        status: 200,
        body: { kind: 'accepted', carrierCallId: 'cid@ovo', carrierRequestId: 'req-1' },
      },
    ]);
    expect(await control(client).dial(dial)).toEqual({
      kind: 'accepted',
      requestId: 'req-1',
      carrierCallId: 'cid@ovo',
      carrierRequestId: 'req-1',
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/calls',
        body: {
          requestId: 'req-1',
          carrierId: 'sip',
          bindingId: 'b1',
          trunkId: 'trunk-a',
          to: dial.to,
          from: dial.from,
          media: { url: dial.media.url, routeParams: { sid: 's', rt: 'r' } },
          callbacks: { status: dial.callbacks.status, resume: dial.callbacks.resume },
          ringTimeoutSec: 30,
          maxDurationSec: 600,
          credentials: { username: 'ovo', password: 'pw' },
        },
      },
    ]);
  });

  it.each([
    ['an https media URL', { ...dial, media: { ...dial.media, url: 'https://x.test/m' } }, 'wss'],
    [
      'a media URL with a query',
      { ...dial, media: { ...dial.media, url: `${dial.media.url}?a=1` } },
      'query',
    ],
    ['a from number outside the binding', { ...dial, from: '+918000000002' }, 'from_not_permitted'],
  ])('rejects %s without a request', async (_label, request, reason) => {
    const { seen, client } = scripted([]);
    const result = await control(client).dial(request);
    expect(result).toMatchObject({ kind: 'rejected', retryable: false });
    expect(result.kind === 'rejected' && result.reason).toContain(reason);
    expect(seen).toEqual([]);
  });

  it('rejects non-retryably when the host capability or the trunk is missing, or dial is refused', async () => {
    expect(await control(undefined).dial(dial)).toMatchObject({
      kind: 'rejected',
      retryable: false,
      reason: 'sip_trunk_unavailable',
    });
    const noTrunk = { ...binding, config: {} };
    expect(await control(scripted([]).client, { binding: noTrunk }).dial(dial)).toMatchObject({
      reason: 'binding_missing_trunk',
    });
    const refused = control(scripted([]).client, { dialAllowed: () => 'outbound_disabled' });
    expect(await refused.dial(dial)).toMatchObject({
      reason: 'outbound_disabled',
      retryable: false,
    });
    const badSecret = { ...binding, secret: 'plain' };
    expect(await control(scripted([]).client, { binding: badSecret }).dial(dial)).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
  });

  it('maps control API refusals and failures', async () => {
    const run = async (reply: { status: number; body: unknown }) =>
      control(scripted([reply]).client).dial(dial);
    expect(
      await run({
        status: 422,
        body: { kind: 'rejected', reason: 'country_not_allowed', retryable: false },
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'country_not_allowed', retryable: false });
    expect(
      await run({
        status: 503,
        body: { kind: 'rejected', reason: 'at_capacity', retryable: true },
      }),
    ).toMatchObject({ kind: 'rejected', retryable: true });
    expect(await run({ status: 401, body: null })).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
    expect(await run({ status: 500, body: null })).toMatchObject({ kind: 'unknown' });
    const thrown = { request: async () => Promise.reject(new Error('ECONNREFUSED')) };
    expect(await control(thrown).dial(dial)).toMatchObject({
      kind: 'unknown',
      reason: 'ECONNREFUSED',
    });
  });

  it('reconciles by request id only when dial produced an id', async () => {
    const { seen, client } = scripted([
      { status: 200, body: { kind: 'ended', carrierCallId: 'cid@ovo', state: 'busy' } },
    ]);
    const telephony = control(client);
    expect(await telephony.reconcile({ requestId: 'req-1' })).toEqual({ kind: 'pending' });
    expect(await telephony.reconcile({ requestId: 'req-1', carrierRequestId: 'req-1' })).toEqual({
      kind: 'ended',
      carrierCallId: 'cid@ovo',
      state: 'busy',
    });
    expect(seen).toEqual([{ method: 'GET', path: '/v1/calls', query: { requestId: 'req-1' } }]);
    const broken = control(scripted([{ status: 500, body: null }]).client);
    expect(await broken.reconcile({ requestId: 'req-1', carrierCallId: 'cid' })).toEqual({
      kind: 'pending',
    });
    expect(await control(undefined).reconcile({ requestId: 'r', carrierRequestId: 'r' })).toEqual({
      kind: 'pending',
    });
  });

  it('hangs up by Call-ID or request id', async () => {
    const { seen, client } = scripted([
      { status: 200, body: { result: 'ended' } },
      { status: 200, body: { result: 'already_ended' } },
      { status: 500, body: null },
    ]);
    const telephony = control(client);
    expect(await telephony.hangup({ carrierCallId: 'cid' })).toBe('ended');
    expect(await telephony.hangup({ carrierRequestId: 'req-1' })).toBe('already_ended');
    await expect(telephony.hangup({ carrierCallId: 'cid' })).rejects.toThrow(/500/);
    expect(await telephony.hangup({})).toBe('unsupported');
    expect(seen.map((s) => s.body)).toEqual([
      { carrierCallId: 'cid' },
      { carrierRequestId: 'req-1' },
      { carrierCallId: 'cid' },
    ]);
    await expect(control(undefined).hangup({ carrierCallId: 'cid' })).rejects.toThrow();
  });

  it('refuses undeclared handoffs locally and forwards a declared phone handoff', async () => {
    const none = scripted([]);
    expect(
      await control(none.client).handoff('cid', { kind: 'phone', e164: '+919000000000' }, 'h-1'),
    ).toMatchObject({ kind: 'rejected', retryable: false });
    expect(none.seen).toEqual([]);
    const { seen, client } = scripted([
      { status: 200, body: { kind: 'confirmed', receiptId: 'rc-1' } },
    ]);
    const telephony = control(client, { handoff: ['phone'] });
    expect(await telephony.handoff('cid', { kind: 'phone', e164: '+919000000000' }, 'h-1')).toEqual(
      {
        kind: 'confirmed',
        receiptId: 'rc-1',
      },
    );
    expect(await telephony.handoff('cid', { kind: 'end', message: 'bye' }, 'h-2')).toMatchObject({
      kind: 'rejected',
    });
    expect(seen).toHaveLength(1);
  });
});

describe('parseSipCredentials', () => {
  it('treats an empty secret as IP auth and parses digest credentials', () => {
    expect(parseSipCredentials('')).toBeNull();
    expect(parseSipCredentials('{"username":"u","password":"p"}')).toEqual({
      username: 'u',
      password: 'p',
    });
    expect(() => parseSipCredentials('{"username":"u"}')).toThrow(/username and password/);
    expect(() => parseSipCredentials('x')).toThrow(/JSON/);
  });
});

describe('createSipTrunkHttpClient', () => {
  it('sends bearer JSON to /v1 paths and parses JSON replies', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createSipTrunkHttpClient({
      baseUrl: 'http://172.29.240.1:5090',
      token: 'tok',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{"kind":"pending"}', { status: 200 });
      }) as typeof fetch,
    });
    expect(
      await client.request({ method: 'GET', path: '/v1/calls', query: { requestId: 'a b' } }),
    ).toEqual({ status: 200, body: { kind: 'pending' } });
    expect(calls[0]!.url).toBe('http://172.29.240.1:5090/v1/calls?requestId=a+b');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer tok' });
    await client.request({
      method: 'POST',
      path: '/v1/calls/hangup',
      body: { carrierCallId: 'c' },
    });
    expect(calls[1]!.init).toMatchObject({
      method: 'POST',
      body: '{"carrierCallId":"c"}',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('refuses paths outside /v1, an empty token and a non-http base', async () => {
    const client = createSipTrunkHttpClient({ baseUrl: 'http://127.0.0.1:5090', token: 't' });
    expect(() => client.request({ method: 'GET', path: '//evil.test/v1/calls' })).toThrow();
    expect(() => createSipTrunkHttpClient({ baseUrl: 'http://x', token: '' })).toThrow();
    expect(() => createSipTrunkHttpClient({ baseUrl: 'ftp://x', token: 't' })).toThrow();
  });

  it('times out a hung control API', async () => {
    const client = createSipTrunkHttpClient({
      baseUrl: 'http://127.0.0.1:5090',
      token: 't',
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        )) as typeof fetch,
    });
    await expect(client.request({ method: 'GET', path: '/v1/health' })).rejects.toThrow();
  });
});
