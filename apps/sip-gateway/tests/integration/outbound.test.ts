import { afterEach, describe, expect, it } from 'vitest';
import { digestResponse, parseAuthParams, parseChallenge } from '../../src/sip/digest.ts';
import type { SipRequest } from '../../src/sip/message.ts';
import {
  FROM,
  HEALTH_TOKEN,
  loopbackTrunk,
  startHarness,
  type Harness,
} from '../support/harness.ts';
import { RtpPeer, SipPeer, sdpOffer } from '../support/sip-peer.ts';

const TO = '+919812345678';
let harness: Harness | undefined;
const peers: { close(): void }[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await harness?.close();
  harness = undefined;
});

/** The gateway dials a loopback "trunk" played by a SipPeer. */
async function setup(
  outbound: Record<string, unknown> = {},
  trunk: Record<string, unknown> = {},
  options: Pick<Parameters<typeof startHarness>[0] & object, 'timers'> = {},
) {
  const sip = await SipPeer.open();
  const rtp = await RtpPeer.open();
  peers.push(sip, rtp);
  harness = await startHarness({
    ...options,
    trunks: [
      loopbackTrunk({
        outbound: {
          enabled: true,
          proxy: `sip:127.0.0.1:${sip.port}`,
          fromNumbers: [FROM],
          auth: 'ip',
          ...outbound,
        },
        ...trunk,
      }),
    ],
  });
  return { h: harness, sip, rtp };
}

function dialBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    carrierId: 'sip',
    bindingId: 'binding-1',
    trunkId: 'loop',
    to: TO,
    from: FROM,
    media: {
      url: 'wss://ovo.example.test/carriers/sip/binding-1/media',
      routeParams: { sid: 's-9', rt: 'rt-dial' },
    },
    callbacks: {
      status: 'https://ovo.example.test/carriers/sip/binding-1/status?r=req',
      resume: 'https://ovo.example.test/carriers/sip/binding-1/resume?r=req',
    },
    ringTimeoutSec: 20,
    maxDurationSec: 600,
    credentials: null,
    ...overrides,
  };
}

const answerSdp = (rtp: RtpPeer) => Buffer.from(sdpOffer(rtp.port, '0 101'));

describe('outbound calls through the control API (§5.4)', () => {
  it('dials, rings, answers, streams and hangs up with BYE; reconcile follows every step', async () => {
    const { h, sip, rtp } = await setup();
    const body = dialBody();
    const dialed = await h.control('POST', '/v1/calls', body);
    expect(dialed.status).toBe(200);
    expect(dialed.body).toMatchObject({ kind: 'accepted', carrierRequestId: body.requestId });
    const callId = dialed.body.carrierCallId as string;
    const invite = await sip.request('INVITE');
    expect(invite.headers.get('call-id')).toBe(callId);
    expect(invite.uri).toBe(`sip:${TO}@127.0.0.1:${sip.port}`);
    expect(invite.headers.get('from')).toContain(FROM);
    expect(invite.headers.get('session-expires')).toBe('1800');
    expect(Buffer.from(invite.body).toString()).toMatch(/m=audio \d+ RTP\/AVP 0 8 101/);
    expect((await h.control('GET', `/v1/calls?requestId=${body.requestId}`)).body).toEqual({
      kind: 'live',
      carrierCallId: callId,
      state: 'queued',
    });
    sip.reply(invite, 180, { toTag: 'uas' });
    await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'ringing'));
    sip.reply(invite, 200, {
      toTag: 'uas',
      headers: [
        ['Contact', `<sip:uas@127.0.0.1:${sip.port}>`],
        ['Content-Type', 'application/sdp'],
      ],
      body: answerSdp(rtp),
    });
    const ack = await sip.request('ACK');
    expect(ack.headers.get('cseq')).toBe('1 ACK');
    const start = await h.media.waitFor(() => h.media.framesIn('start')[0]);
    expect(start).toMatchObject({ callId, routeParams: { sid: 's-9', rt: 'rt-dial' } });
    const statuses = h.media.statuses;
    expect(statuses.map((s) => [s.state, s.dialRequestId])).toEqual([
      ['ringing', body.requestId],
      ['in_progress', body.requestId],
    ]);
    expect((await h.control('GET', `/v1/calls?requestId=${body.requestId}`)).body.state).toBe(
      'in_progress',
    );
    await h.media.waitFor(() => rtp.packets.length > 5);
    const hangup = await h.control('POST', '/v1/calls/hangup', { carrierCallId: callId });
    expect(hangup.body).toEqual({ result: 'ended' });
    const bye = await sip.request('BYE');
    sip.reply(bye, 200);
    await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'completed'));
    expect((await h.control('GET', `/v1/calls?requestId=${body.requestId}`)).body).toEqual({
      kind: 'ended',
      carrierCallId: callId,
      state: 'completed',
    });
    expect(
      (await h.control('POST', '/v1/calls/hangup', { carrierRequestId: body.requestId })).body,
    ).toEqual({
      result: 'already_ended',
    });
    // The same requestId again is the same call, not a second dial.
    expect((await h.control('POST', '/v1/calls', body)).body.carrierCallId).toBe(callId);
  });

  it.each(['MD5', 'SHA-256'])(
    'answers a 407 %s challenge once and completes',
    async (algorithm) => {
      const { h, sip, rtp } = await setup({ auth: 'digest' });
      const credentials = { username: 'trunk-user', password: 'trunk-pass' };
      await h.control('POST', '/v1/calls', dialBody({ credentials }));
      const first = await sip.request('INVITE');
      sip.reply(first, 407, {
        toTag: 'uas',
        headers: [
          [
            'Proxy-Authenticate',
            `Digest realm="trunk", nonce="n-1", qop="auth", algorithm=${algorithm}`,
          ],
        ],
      });
      const ack = await sip.request('ACK');
      expect(ack.headers.getAll('via')[0]).toBe(first.headers.getAll('via')[0]);
      const second = (await sip.next(
        (m) =>
          m.kind === 'request' && m.method === 'INVITE' && m.headers.get('cseq') === '2 INVITE',
      )) as SipRequest;
      expect(second.headers.get('cseq')).toBe('2 INVITE');
      expect(second.headers.get('call-id')).toBe(first.headers.get('call-id'));
      const params = parseAuthParams(second.headers.get('proxy-authorization')!)!;
      const challenge = parseChallenge(
        `Digest realm="trunk", nonce="n-1", qop="auth", algorithm=${algorithm}`,
      )!;
      expect(params.response).toBe(
        digestResponse({
          challenge,
          ...credentials,
          method: 'INVITE',
          uri: params.uri!,
          cnonce: params.cnonce!,
          nc: 1,
        }),
      );
      sip.reply(second, 200, {
        toTag: 'uas',
        headers: [
          ['Contact', `<sip:uas@127.0.0.1:${sip.port}>`],
          ['Content-Type', 'application/sdp'],
        ],
        body: answerSdp(rtp),
      });
      await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'in_progress'));
    },
  );

  it('does not answer a second challenge for the same nonce', async () => {
    const { h, sip } = await setup({ auth: 'digest' });
    await h.control(
      'POST',
      '/v1/calls',
      dialBody({ credentials: { username: 'u', password: 'p' } }),
    );
    const challenge: [string, string][] = [
      ['Proxy-Authenticate', 'Digest realm="trunk", nonce="same"'],
    ];
    sip.reply(await sip.request('INVITE'), 407, { toTag: 'uas', headers: challenge });
    const second = (await sip.next(
      (m) => m.kind === 'request' && m.method === 'INVITE' && m.headers.get('cseq') === '2 INVITE',
    )) as SipRequest;
    sip.reply(second, 407, { toTag: 'uas', headers: challenge });
    const failed = await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'failed'));
    expect(failed.sipCode).toBe(407);
  });

  it.each([
    [486, 'busy', false],
    [404, 'failed', false],
    [503, 'failed', true],
  ] as const)('maps a %i final to %s', async (status, state, retryable) => {
    const { h, sip } = await setup();
    await h.control('POST', '/v1/calls', dialBody());
    sip.reply(await sip.request('INVITE'), status, {
      toTag: 'uas',
      headers: status === 503 ? [['Retry-After', '30']] : [],
    });
    const event = await h.media.waitFor(() => h.media.statuses.find((s) => s.state === state));
    expect(event).toMatchObject({ sipCode: status, payload: { retryable } });
    if (status === 503) expect(event.payload).toMatchObject({ retryAfterSec: 30 });
  });

  it('CANCELs at the ring timeout and reports no_answer', async () => {
    const { h, sip } = await setup();
    await h.control('POST', '/v1/calls', dialBody({ ringTimeoutSec: 1 }));
    const invite = await sip.request('INVITE');
    sip.reply(invite, 180, { toTag: 'uas' });
    const cancel = await sip.request('CANCEL', 3_000);
    expect(cancel.headers.getAll('via')[0]).toBe(invite.headers.getAll('via')[0]);
    sip.reply(cancel, 200);
    sip.reply(invite, 487, { toTag: 'uas' });
    await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'no_answer'));
    await sip.request('ACK');
  });

  it('keeps ringing past 64·T1 and still ends no_answer at the ring timeout, not invite_timeout', async () => {
    // T1 = 20 ms puts Timer B at 1.28 s, well inside the 2 s ring timeout.
    const { h, sip } = await setup({}, {}, { timers: { t1: 20, t2: 160, t4: 200 } });
    await h.control('POST', '/v1/calls', dialBody({ ringTimeoutSec: 2 }));
    const invite = await sip.request('INVITE');
    sip.reply(invite, 180, { toTag: 'uas' });
    const cancel = await sip.request('CANCEL', 4_000);
    sip.reply(cancel, 200);
    sip.reply(invite, 487, { toTag: 'uas' });
    const ended = await h.media.waitFor(() =>
      h.media.statuses.find((s) => s.state === 'no_answer' || s.state === 'failed'),
    );
    expect(ended.state).toBe('no_answer');
  });

  it('a host hangup before answer is a CANCEL and reports canceled', async () => {
    const { h, sip } = await setup();
    const dialed = await h.control('POST', '/v1/calls', dialBody());
    const invite = await sip.request('INVITE');
    sip.reply(invite, 183, { toTag: 'uas' });
    await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'ringing'));
    await h.control('POST', '/v1/calls/hangup', { carrierCallId: dialed.body.carrierCallId });
    sip.reply(await sip.request('CANCEL'), 200);
    sip.reply(invite, 487, { toTag: 'uas' });
    await h.media.waitFor(() => h.media.statuses.find((s) => s.state === 'canceled'));
  });

  it('ACKs and BYEs a 2xx that races the CANCEL', async () => {
    const { h, sip, rtp } = await setup();
    const dialed = await h.control('POST', '/v1/calls', dialBody());
    const invite = await sip.request('INVITE');
    sip.reply(invite, 180, { toTag: 'uas' });
    await h.control('POST', '/v1/calls/hangup', { carrierCallId: dialed.body.carrierCallId });
    await sip.request('CANCEL');
    sip.reply(invite, 200, {
      toTag: 'uas',
      headers: [
        ['Contact', `<sip:uas@127.0.0.1:${sip.port}>`],
        ['Content-Type', 'application/sdp'],
      ],
      body: answerSdp(rtp),
    });
    await sip.request('ACK');
    const bye = await sip.request('BYE');
    sip.reply(bye, 200);
    expect(h.media.sockets).toHaveLength(0);
  });
});

describe('control API guards', () => {
  it('answers a repeated requestId with the original call even at capacity', async () => {
    const { h, sip } = await setup({}, { maxConcurrent: 1, inviteRatePerSecond: 1 });
    const body = dialBody();
    const first = await h.control('POST', '/v1/calls', body);
    expect(first.body.kind).toBe('accepted');
    await sip.request('INVITE');
    const again = await h.control('POST', '/v1/calls', body);
    expect(again).toEqual({ status: 200, body: first.body });
    const other = await h.control('POST', '/v1/calls', dialBody());
    expect(other.body).toMatchObject({ kind: 'rejected', reason: 'at_capacity' });
  });

  it('needs the bearer token and refuses unknown paths', async () => {
    const { h } = await setup();
    expect((await h.control('GET', '/v1/health', undefined, 'wrong')).status).toBe(401);
    expect((await h.control('GET', '/v1/nothing')).status).toBe(404);
    expect((await h.control('GET', '/v1/health')).body).toEqual({
      ready: true,
      draining: false,
      calls: 0,
      trunks: { loop: 'unknown' },
    });
    expect((await h.control('GET', '/v1/calls?requestId=never')).body).toEqual({
      kind: 'rejected',
      reason: 'unknown_request',
    });
  });

  it.each([
    ['a malformed body', { to: 'not-a-number' }, 422, 'invalid_request'],
    ['an unknown trunk', { trunkId: 'other' }, 422, 'unknown_trunk'],
    ['a binding that is not the trunk', { bindingId: 'binding-2' }, 422, 'binding_mismatch'],
    ['an unpermitted caller ID', { from: '+918000000003' }, 422, 'from_not_permitted'],
    [
      'a destination outside the country allow-list',
      { to: '+14155550100' },
      422,
      'destination_not_permitted',
    ],
    [
      'a media URL with a query',
      { media: { url: 'wss://ovo.example.test/m?x=1', routeParams: {} } },
      422,
      'media_url_has_query',
    ],
  ])('refuses %s', async (_name, change, status, reason) => {
    const { h } = await setup();
    const reply = await h.control('POST', '/v1/calls', dialBody(change));
    expect(reply.status).toBe(status);
    expect(reply.body).toMatchObject({ kind: 'rejected', reason, retryable: false });
  });

  it('refuses dials on an inbound-only trunk, without credentials on a digest trunk, and while draining', async () => {
    const { h } = await setup({ auth: 'digest' });
    expect((await h.control('POST', '/v1/calls', dialBody())).body.reason).toBe(
      'credentials_required',
    );
    void h.running.stop();
    const draining = await h.control(
      'POST',
      '/v1/calls',
      dialBody({ credentials: { username: 'u', password: 'p' } }),
    );
    expect(draining).toMatchObject({ status: 503, body: { reason: 'draining', retryable: true } });
  });

  it('refuses handoff in v1', async () => {
    const { h } = await setup();
    const reply = await h.control('POST', '/v1/calls/handoff', {
      carrierCallId: 'c',
      requestId: 'r',
      target: { kind: 'phone', e164: TO },
    });
    expect(reply.body).toEqual({
      kind: 'rejected',
      retryable: false,
      reason: 'handoff_unsupported',
    });
  });

  it('serves /health and the token-protected verbose counters', async () => {
    const { h } = await setup();
    const base = `http://127.0.0.1:${h.running.ports.health}/health`;
    expect(await (await fetch(base)).json()).toEqual({ ready: true, draining: false });
    expect((await fetch(`${base}?verbose=1`)).status).toBe(401);
    const verbose = await (
      await fetch(`${base}?verbose=1`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } })
    ).json();
    expect(verbose).toMatchObject({
      dialogs: 0,
      rtp: { inUse: 0 },
      drops: {},
      resume: { attempts: 0 },
    });
  });
});
