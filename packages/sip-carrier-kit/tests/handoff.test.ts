import type { SipTrunkControlClient } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  SipHandoffRequestSchema,
  SipHandoffResponseSchema,
  createSipControlFactory,
  sipCarrierCapabilities,
} from '../src/index.ts';

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
const control = (client: SipTrunkControlClient, options: { handoff: ('phone' | 'sip')[] }) =>
  createSipControlFactory({
    capabilities: sipCarrierCapabilities('sip', { handoff: options.handoff }),
    client: () => client,
  }).create({
    bindingId: 'b1',
    pluginId: '@winsendotai/ovo-carrier-sip',
    workspaceId: 'w1',
    config: { trunkId: 'trunk-a' },
    secret: '',
  });

describe('SIP REFER handoff over the control API', () => {
  const sip = {
    kind: 'sip' as const,
    uri: 'sips:acd@sbc.example.net',
    headers: { 'X-OVO-Ticket': 't-1', 'X-OVO-Language': 'en' },
  };

  it('forwards a sip target with its headers and relays confirmed, rejected and unknown answers', async () => {
    const { seen, client } = scripted([
      { status: 200, body: { kind: 'confirmed', receiptId: 'refer:cid:h-1' } },
      {
        status: 200,
        body: { kind: 'rejected', reason: 'refer_host_not_allowed', retryable: false },
      },
      { status: 200, body: { kind: 'unknown', reason: 'refer_no_notify' } },
    ]);
    const telephony = control(client, { handoff: ['phone', 'sip'] });
    expect(await telephony.handoff('cid', sip, 'h-1')).toEqual({
      kind: 'confirmed',
      receiptId: 'refer:cid:h-1',
    });
    expect(await telephony.handoff('cid', sip, 'h-2')).toEqual({
      kind: 'rejected',
      reason: 'refer_host_not_allowed',
      retryable: false,
    });
    expect(await telephony.handoff('cid', sip, 'h-3')).toEqual({
      kind: 'unknown',
      reason: 'refer_no_notify',
    });
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/v1/calls/handoff',
      body: { carrierCallId: 'cid', requestId: 'h-1', target: sip },
    });
  });

  it('refuses a sip target locally when the carrier does not declare it', async () => {
    const { seen, client } = scripted([]);
    expect(await control(client, { handoff: ['phone'] }).handoff('cid', sip, 'h-1')).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
    expect(seen).toEqual([]);
  });

  it('is unknown, not rejected, when the gateway answers something unparsable or the call throws', async () => {
    const telephony = control(scripted([{ status: 502, body: 'bad gateway' }]).client, {
      handoff: ['sip'],
    });
    expect(await telephony.handoff('cid', sip, 'h-1')).toEqual({
      kind: 'unknown',
      reason: 'sip-gateway HTTP 502',
    });
    const throwing: SipTrunkControlClient = {
      request: async () => {
        throw new Error('socket hang up');
      },
    };
    expect(await control(throwing, { handoff: ['sip'] }).handoff('cid', sip, 'h-2')).toEqual({
      kind: 'unknown',
      reason: 'socket hang up',
    });
  });
});

describe('ovo-sip/1 handoff schemas', () => {
  const request = (target: unknown) =>
    SipHandoffRequestSchema.safeParse({ carrierCallId: 'cid', requestId: 'r-1', target });

  it('accepts phone and sip targets', () => {
    expect(request({ kind: 'phone', e164: '+919000000000' }).success).toBe(true);
    expect(
      request({ kind: 'sip', uri: 'sip:agent@acd.example.net:5060;transport=tcp' }).success,
    ).toBe(true);
    expect(
      request({
        kind: 'sip',
        uri: 'SIPS:acd@sbc.example.net',
        headers: { 'X-OVO-Ticket': 't-1', 'x-lower': '' },
      }).success,
    ).toBe(true);
  });

  it.each([
    { kind: 'queue', name: 'q' },
    { kind: 'sip', uri: 'tel:+919000000000' },
    { kind: 'sip', uri: 'http://acd.example.net' },
    { kind: 'sip', uri: 'sip:a@b.example?X-Evil=1' },
    { kind: 'sip', uri: 'sip:a@b.example>\r\nVia: x' },
    { kind: 'sip', uri: 'sip:a@b .example' },
    { kind: 'sip', uri: 'sip:a@b.example', extra: true },
    { kind: 'sip', uri: 'sip:a@b.example', headers: { Via: 'x' } },
    { kind: 'sip', uri: 'sip:a@b.example', headers: { 'X-A': 'two\nlines' } },
    { kind: 'sip', uri: 'sip:a@b.example', headers: { 'X-A': 'x'.repeat(257) } },
    {
      kind: 'sip',
      uri: 'sip:a@b.example',
      headers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`X-H${i}`, 'v'])),
    },
  ])('refuses the target %j', (target) => expect(request(target).success).toBe(false));

  it('parses the three handoff answers and nothing else', () => {
    for (const body of [
      { kind: 'confirmed', receiptId: 'r' },
      { kind: 'rejected', reason: 'refer_not_enabled', retryable: false },
      { kind: 'unknown', reason: 'refer_no_notify' },
    ])
      expect(SipHandoffResponseSchema.safeParse(body).success).toBe(true);
    expect(SipHandoffResponseSchema.safeParse({ kind: 'queued' }).success).toBe(false);
  });
});
