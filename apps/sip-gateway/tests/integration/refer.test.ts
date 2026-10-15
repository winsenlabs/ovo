import { afterEach, describe, expect, it } from 'vitest';
import type { SipRequest, SipResponse } from '../../src/sip/message.ts';
import { DID, loopbackTrunk, startHarness, sleep, type Harness } from '../support/harness.ts';
import { RtpPeer, SipPeer, ackFor, inDialog, invite, sdpOffer } from '../support/sip-peer.ts';

// R3: the trunk is asked to take the caller away with an in-dialog REFER (RFC 3515); SipPeer plays
// the trunk's far end, sending the 202 and the sipfrag NOTIFYs by hand.
let harness: Harness | undefined;
const peers: { close(): void }[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await harness?.close();
  harness = undefined;
});

const REFER = {
  enabled: true,
  phoneUriTemplate: 'sip:{e164}@sbc.example.net;user=phone',
  allowedHosts: ['.acd.example.net', 'transfer.example.net'],
};
const SIP_TARGET = {
  kind: 'sip',
  uri: 'sips:desk@queue.acd.example.net',
  headers: { 'X-OVO-Ticket': 't-1', 'X-OVO-Language': 'en IN', 'X-OVO-Note': 'a&b=c' },
} as const;

async function setup(refer: Record<string, unknown> | null = REFER, env = {}) {
  harness = await startHarness({
    env: { OVO_SIP_REFER_TIMEOUT_MS: '2000', ...env },
    trunks: [loopbackTrunk(refer ? { refer } : {})],
  });
  const sip = await SipPeer.open();
  const rtp = await RtpPeer.open();
  peers.push(sip, rtp);
  const leg = invite({ peerPort: sip.port, to: DID, body: sdpOffer(rtp.port) });
  sip.send(leg.invite, harness.sipPort);
  const ok = await sip.response(200);
  sip.send(ackFor(leg, ok), harness.sipPort);
  await harness.media.waitFor(() => harness!.media.framesIn('start')[0]);
  return { h: harness, sip, leg, ok, cseq: 1 };
}
type Call = Awaited<ReturnType<typeof setup>>;

let handoffSeq = 0;
const handoff = (c: Call, target: unknown, requestId = `h-${(handoffSeq += 1)}`) =>
  c.h.control('POST', '/v1/calls/handoff', { carrierCallId: c.leg.callId, requestId, target });

/** A sipfrag NOTIFY from the far end on the REFER's subscription. */
function notify(
  c: Call,
  refer: SipRequest | undefined,
  frag: string,
  state: string,
  event?: string,
) {
  c.cseq += 1;
  const request = inDialog(c.leg, c.ok, 'NOTIFY', c.cseq, c.sip.port);
  const id = refer ? /^(\d+)/.exec(refer.headers.get('cseq')!)![1] : '1';
  request.headers
    .set('event', event ?? `refer;id=${id}`)
    .set('subscription-state', state)
    .set('content-type', 'message/sipfrag;version=2.0');
  return { ...request, body: Buffer.from(frag) };
}
const frag = (status: number) => `SIP/2.0 ${status} ${status === 200 ? 'OK' : 'Status'}\r\n`;
async function send(c: Call, request: SipRequest): Promise<SipResponse> {
  c.sip.send(request, c.h.sipPort);
  return c.sip.next(
    (m) => m.kind === 'response' && m.headers.get('cseq') === request.headers.get('cseq'),
  ) as Promise<SipResponse>;
}
const referTo = (refer: SipRequest) => /<([^>]+)>/.exec(refer.headers.get('refer-to')!)![1]!;

describe('SIP REFER handoff (R3)', () => {
  it('accepted: 202, sipfrag 100 then 200 confirms, then BYE and a transferred stop', async () => {
    const c = await setup();
    const pending = handoff(c, SIP_TARGET, 'h-ok');
    const refer = await c.sip.request('REFER');
    expect(refer.headers.get('cseq')).toMatch(/^\d+ REFER$/);
    expect(referTo(refer)).toBe(
      'sips:desk@queue.acd.example.net?X-OVO-Ticket=t-1&X-OVO-Language=en%20IN&X-OVO-Note=a%26b%3Dc',
    );
    expect(refer.headers.get('referred-by')).toBe('<sip:ovo@127.0.0.1>');
    expect(refer.headers.get('contact')).toMatch(/^<sip:/);
    expect(refer.headers.getAll('via')).toHaveLength(1);
    c.sip.reply(refer, 202);
    expect((await send(c, notify(c, refer, frag(100), 'active;expires=60'))).status).toBe(200);
    expect(
      (await send(c, notify(c, refer, frag(200), 'terminated;reason=noresource'))).status,
    ).toBe(200);
    const reply = await pending;
    expect(reply.body).toMatchObject({ kind: 'confirmed' });
    expect(reply.body.receiptId).toMatch(/^sip-refer:[0-9a-f]{32}$/);
    // The gateway leaves: BYE to the far end, then the media stream stops as `transferred`.
    const bye = await c.sip.request('BYE');
    c.sip.reply(bye, 200);
    await c.h.media.waitFor(() => c.h.media.framesIn('stop')[0]);
    expect(c.h.media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'transferred' });
    const done = await c.h.media.waitFor(() =>
      c.h.media.statuses.find((s) => s.state === 'completed'),
    );
    expect(done.payload).toMatchObject({ endReason: 'transferred' });
    expect(c.h.running.gateway.registry.size).toBe(0);
    // Logs never carry the destination's user or the headers' values.
    expect(JSON.stringify(c.h.logs)).not.toContain('desk@');
    expect(JSON.stringify(c.h.logs)).not.toContain('t-1');
  });

  it('answers a repeated requestId with the first answer even though the call has left', async () => {
    const c = await setup();
    const pending = handoff(c, SIP_TARGET, 'h-retry');
    const refer = await c.sip.request('REFER');
    c.sip.reply(refer, 202);
    await send(c, notify(c, refer, frag(200), 'terminated'));
    const first = (await pending).body;
    expect(first.kind).toBe('confirmed');
    expect(await handoff(c, SIP_TARGET, 'h-retry')).toMatchObject({ body: first });
    // A different request for a call that is gone is refused outright.
    expect((await handoff(c, SIP_TARGET, 'h-other')).body).toEqual({
      kind: 'rejected',
      reason: 'call_not_found',
      retryable: false,
    });
  });

  it('a phone target goes through the trunk template and carries no headers', async () => {
    const c = await setup();
    const pending = handoff(c, { kind: 'phone', e164: '+919000000042' });
    const refer = await c.sip.request('REFER');
    expect(referTo(refer)).toBe('sip:+919000000042@sbc.example.net;user=phone');
    c.sip.reply(refer, 202);
    await send(c, notify(c, refer, frag(200), 'terminated'));
    expect((await pending).body.kind).toBe('confirmed');
  });

  it('a failing sipfrag rejects (retryable on 503) and keeps the caller, who can be transferred again', async () => {
    const c = await setup();
    const first = handoff(c, SIP_TARGET);
    const refer = await c.sip.request('REFER');
    c.sip.reply(refer, 202);
    await send(c, notify(c, refer, frag(503), 'terminated;reason=noresource'));
    expect((await first).body).toEqual({
      kind: 'rejected',
      reason: 'refer_failed_503',
      retryable: true,
    });
    expect(c.h.running.gateway.registry.size).toBe(1);
    expect(c.h.media.framesIn('stop')).toHaveLength(0);
    // The slot is free again.
    const second = handoff(c, SIP_TARGET);
    const again = await c.sip.next(
      (m) => m.kind === 'request' && m.method === 'REFER' && m !== (refer as unknown),
    );
    c.sip.reply(again as SipRequest, 202);
    await send(c, notify(c, again as SipRequest, frag(603), 'terminated'));
    expect((await second).body).toEqual({
      kind: 'rejected',
      reason: 'refer_failed_603',
      retryable: false,
    });
  });

  it.each([
    [403, false],
    [405, false],
    [408, true],
    [503, true],
  ])(
    'a %i to the REFER itself rejects (retryable %s) and keeps the call',
    async (status, retryable) => {
      const c = await setup();
      const pending = handoff(c, SIP_TARGET);
      c.sip.reply(await c.sip.request('REFER'), status);
      expect((await pending).body).toEqual({
        kind: 'rejected',
        reason: `refer_declined_${status}`,
        retryable,
      });
      expect(c.h.running.gateway.registry.size).toBe(1);
    },
  );

  it('202 but no NOTIFY: unknown refer_no_notify after the timeout, then BYE', async () => {
    const c = await setup();
    const started = Date.now();
    const pending = handoff(c, SIP_TARGET);
    c.sip.reply(await c.sip.request('REFER'), 202);
    expect((await pending).body).toEqual({ kind: 'unknown', reason: 'refer_no_notify' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    c.sip.reply(await c.sip.request('BYE'), 200);
    await c.h.media.waitFor(() => c.h.media.framesIn('stop')[0]);
    expect(c.h.media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'transferred' });
  });

  it('no answer at all to the REFER: unknown refer_no_response and the dialog is left alone', async () => {
    const c = await setup();
    const pending = handoff(c, SIP_TARGET);
    await c.sip.request('REFER');
    expect((await pending).body).toEqual({ kind: 'unknown', reason: 'refer_no_response' });
    expect(c.h.running.gateway.registry.size).toBe(1);
  });

  it('the far end hanging up before the last NOTIFY is unknown, not rejected', async () => {
    const c = await setup();
    const pending = handoff(c, SIP_TARGET);
    const refer = await c.sip.request('REFER');
    c.sip.reply(refer, 202);
    await send(c, notify(c, refer, frag(100), 'active'));
    c.cseq += 1;
    const bye = await send(c, inDialog(c.leg, c.ok, 'BYE', c.cseq, c.sip.port));
    expect(bye.status).toBe(200);
    expect((await pending).body).toEqual({ kind: 'unknown', reason: 'refer_call_ended' });
  });

  it('refuses a second transfer while one is in flight, but joins a repeat of the same request', async () => {
    const c = await setup();
    const first = handoff(c, SIP_TARGET, 'h-1');
    const refer = await c.sip.request('REFER');
    expect((await handoff(c, SIP_TARGET, 'h-2')).body).toEqual({
      kind: 'rejected',
      reason: 'refer_in_progress',
      retryable: true,
    });
    const repeat = handoff(c, SIP_TARGET, 'h-1');
    c.sip.reply(refer, 202);
    await send(c, notify(c, refer, frag(200), 'terminated'));
    expect((await first).body.kind).toBe('confirmed');
    expect((await repeat).body).toEqual((await first).body);
    // One REFER only ever went out.
    expect(c.sip.received.filter((m) => m.kind === 'request' && m.method === 'REFER')).toHaveLength(
      1,
    );
  });

  describe('policy, before anything is sent', () => {
    const rejected = (reason: string, retryable = false) => ({
      kind: 'rejected',
      reason,
      retryable,
    });

    it.each([
      ['a disabled trunk', { ...REFER, enabled: false }, SIP_TARGET, 'refer_not_enabled'],
      ['a trunk without a refer block', null, SIP_TARGET, 'refer_not_enabled'],
      [
        'a host off the allow-list',
        REFER,
        { ...SIP_TARGET, uri: 'sips:x@evil.example.com' },
        'refer_host_not_allowed',
      ],
      [
        'a suffix that is not a subdomain',
        REFER,
        { ...SIP_TARGET, uri: 'sip:x@acd.example.net' },
        'refer_host_not_allowed',
      ],
      [
        'a look-alike host',
        REFER,
        { ...SIP_TARGET, uri: 'sip:x@evilacd.example.net' },
        'refer_host_not_allowed',
      ],
      [
        'no allow-list at all',
        { ...REFER, allowedHosts: [] },
        SIP_TARGET,
        'refer_host_not_allowed',
      ],
      [
        'a phone target without a template',
        { enabled: true, allowedHosts: ['.acd.example.net'] },
        { kind: 'phone', e164: '+919000000042' },
        'refer_phone_template_missing',
      ],
    ])('%s is refused', async (_label, refer, target, reason) => {
      const c = await setup(refer);
      expect((await handoff(c, target)).body).toEqual(rejected(reason));
      await sleep(100);
      expect(c.sip.received.some((m) => m.kind === 'request' && m.method === 'REFER')).toBe(false);
    });

    it('an unknown call, and an invalid target, are refused at the door', async () => {
      const c = await setup();
      const body = (
        await c.h.control('POST', '/v1/calls/handoff', {
          carrierCallId: 'nope@host',
          requestId: 'r',
          target: { kind: 'phone', e164: '+919000000042' },
        })
      ).body;
      expect(body).toEqual(rejected('call_not_found'));
      const bad = await c.h.control('POST', '/v1/calls/handoff', {
        carrierCallId: c.leg.callId,
        requestId: 'r2',
        target: { kind: 'sip', uri: 'sip:a@acd.example.net?X-Evil=1' },
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('NOTIFY handling', () => {
    it('a NOTIFY with no REFER in flight gets 481', async () => {
      const c = await setup();
      const stray = await send(c, notify(c, undefined, frag(200), 'terminated'));
      expect(stray.status).toBe(481);
      expect(c.h.running.gateway.registry.size).toBe(1);
    });

    it('a NOTIFY for another subscription or event gets 481 and changes nothing', async () => {
      const c = await setup();
      const pending = handoff(c, SIP_TARGET);
      const refer = await c.sip.request('REFER');
      c.sip.reply(refer, 202);
      expect(
        (await send(c, notify(c, refer, frag(200), 'terminated', 'refer;id=999999'))).status,
      ).toBe(481);
      expect((await send(c, notify(c, refer, frag(200), 'terminated', 'presence'))).status).toBe(
        481,
      );
      expect((await send(c, notify(c, refer, frag(200), 'terminated', 'refer'))).status).toBe(200);
      expect((await pending).body.kind).toBe('confirmed');
    });

    it('reads the subscription id among other Event parameters, in any order', async () => {
      const c = await setup();
      const pending = handoff(c, SIP_TARGET);
      const refer = await c.sip.request('REFER');
      c.sip.reply(refer, 202);
      const id = Number(/^(\d+)/.exec(refer.headers.get('cseq')!)![1]);
      const wrongId = notify(c, refer, frag(100), 'active', `refer;id=${id + 7};x=1`);
      expect((await send(c, wrongId)).status).toBe(481);
      const reordered = notify(c, refer, frag(200), 'terminated', `refer;x=1;id=${id}`);
      expect((await send(c, reordered)).status).toBe(200);
      expect((await pending).body.kind).toBe('confirmed');
    });

    it('a NOTIFY that is not a sipfrag gets 400 and the transfer keeps waiting', async () => {
      const c = await setup();
      const pending = handoff(c, SIP_TARGET);
      const refer = await c.sip.request('REFER');
      c.sip.reply(refer, 202);
      const junk = notify(c, refer, 'hello', 'active');
      expect((await send(c, junk)).status).toBe(400);
      const wrongType = notify(c, refer, frag(200), 'active');
      wrongType.headers.set('content-type', 'text/plain');
      expect((await send(c, wrongType)).status).toBe(400);
      expect((await send(c, notify(c, refer, frag(200), 'terminated'))).status).toBe(200);
      expect((await pending).body.kind).toBe('confirmed');
    });

    it('a NOTIFY that beats the 202 still counts', async () => {
      const c = await setup();
      const pending = handoff(c, SIP_TARGET);
      const refer = await c.sip.request('REFER');
      expect((await send(c, notify(c, refer, frag(200), 'terminated'))).status).toBe(200);
      c.sip.reply(refer, 202);
      expect((await pending).body.kind).toBe('confirmed');
    });

    it('a terminated subscription that never reached a final status is unknown', async () => {
      const c = await setup();
      const pending = handoff(c, SIP_TARGET);
      const refer = await c.sip.request('REFER');
      c.sip.reply(refer, 202);
      await send(c, notify(c, refer, frag(100), 'terminated;reason=timeout'));
      expect((await pending).body).toEqual({ kind: 'unknown', reason: 'refer_subscription_ended' });
    });
  });

  it('advertises NOTIFY in Allow and still answers other methods 405', async () => {
    const c = await setup();
    expect(c.ok.headers.get('allow')).toContain('NOTIFY');
    c.cseq += 1;
    const subscribe = await send(c, inDialog(c.leg, c.ok, 'SUBSCRIBE', c.cseq, c.sip.port));
    expect(subscribe.status).toBe(405);
  });
});
