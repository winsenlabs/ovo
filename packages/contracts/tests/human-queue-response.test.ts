import { describe, expect, it } from 'vitest';
import {
  checkDestination,
  DestinationPolicy,
  parseWebhookResponse,
  readPointer,
} from '../src/index.ts';
import { body, policy, spec } from './human-queue-mapping-fixture.ts';

describe('readPointer', () => {
  it('follows RFC 6901 pointers with escapes and array indexes', () => {
    const doc = { a: { 'b/c': [10, { d: 'x' }], 'e~f': 1 } };
    expect(readPointer(doc, '/a/b~1c/1/d')).toBe('x');
    expect(readPointer(doc, '/a/e~0f')).toBe(1);
    expect(readPointer(doc, '/a/b~1c/0')).toBe(10);
    expect(readPointer(doc, '/a/b~1c/01')).toBeUndefined();
    expect(readPointer(doc, '/a/b~1c/9')).toBeUndefined();
    expect(readPointer(doc, '/missing/x')).toBeUndefined();
    expect(readPointer(doc, '/a/__proto__')).toBeUndefined();
    expect(readPointer('text', '/a')).toBeUndefined();
  });
});

describe('parseWebhookResponse', () => {
  const canonical = spec();
  const mapped = spec({
    response: {
      statusPath: '/result/state',
      acceptedValues: ['OK'],
      queuedValues: ['WAIT'],
      rejectedValues: ['NO'],
      ticketRefPath: '/result/ref',
      destinationE164Path: '/dial/number',
      destinationSipUriPath: '/dial/uri',
      destinationHeadersPath: '/dial/headers',
    },
  });

  it('reads the canonical accepted answer with an E.164 or a SIP destination', () => {
    expect(
      parseWebhookResponse(canonical, 200, {
        status: 'accepted',
        ticketRef: 'acd-1',
        destination: { e164: '+914012345678' },
      }),
    ).toEqual({ kind: 'accepted', destination: { e164: '+914012345678' }, ticketRef: 'acd-1' });
    expect(
      parseWebhookResponse(canonical, 201, {
        status: 'ACCEPTED',
        destination: {
          sipUri: 'sips:a@acd.example.com',
          headers: { 'X-Acd-Ticket': '123', n: 4, bad: {} },
        },
      }),
    ).toEqual({
      kind: 'accepted',
      destination: {
        sipUri: 'sips:a@acd.example.com',
        headers: { 'X-Acd-Ticket': '123', n: '4' },
      },
    });
  });

  it('reads queued, rejected and the other accepted words', () => {
    expect(parseWebhookResponse(canonical, 202, { status: 'queued', ticketRef: 7 })).toEqual({
      kind: 'queued',
      ticketRef: '7',
    });
    expect(parseWebhookResponse(canonical, 200, { status: ' Pending ' })).toEqual({
      kind: 'queued',
    });
    expect(
      parseWebhookResponse(canonical, 200, { status: 'rejected', reason: 'closed today' }),
    ).toEqual({
      kind: 'rejected',
      reason: 'closed today',
    });
    expect(parseWebhookResponse(canonical, 200, { status: 'unavailable' })).toEqual({
      kind: 'rejected',
      reason: 'unavailable',
    });
    expect(
      parseWebhookResponse(canonical, 200, {
        status: 'connected',
        destination: { e164: '+914011111111' },
      }).kind,
    ).toBe('accepted');
  });

  it('reads a mapped answer through its pointers', () => {
    expect(
      parseWebhookResponse(mapped, 200, {
        result: { state: 'ok', ref: 'r-9' },
        dial: { uri: 'sips:b@acd.example.com', headers: { 'X-Acd-Ticket': '9' } },
      }),
    ).toEqual({
      kind: 'accepted',
      destination: { sipUri: 'sips:b@acd.example.com', headers: { 'X-Acd-Ticket': '9' } },
      ticketRef: 'r-9',
    });
    expect(parseWebhookResponse(mapped, 200, { result: { state: 'WAIT' } })).toEqual({
      kind: 'queued',
    });
    expect(parseWebhookResponse(mapped, 200, { result: { state: 'no' }, reason: 'full' })).toEqual({
      kind: 'rejected',
      reason: 'full',
    });
    // The canonical `status` is ignored when a status pointer is set.
    expect(parseWebhookResponse(mapped, 200, { status: 'accepted', result: {} })).toEqual({
      kind: 'invalid',
      reason: 'status',
    });
  });

  it('is invalid when the status is missing, unknown or the body is not an object', () => {
    for (const [status, body, reason] of [
      [500, { status: 'accepted' }, 'status'],
      [302, {}, 'status'],
      [200, {}, 'status'],
      [200, { status: 'maybe' }, 'status'],
      [200, { status: '' }, 'status'],
      [200, { status: {} }, 'status'],
      [200, 'accepted', 'json'],
      [200, ['accepted'], 'json'],
      [200, null, 'json'],
    ] as const)
      expect(parseWebhookResponse(canonical, status, body), JSON.stringify(body)).toEqual({
        kind: 'invalid',
        reason,
      });
  });

  it('is invalid when an accepted answer has no destination or two', () => {
    for (const destination of [
      undefined,
      {},
      { e164: '' },
      { e164: '+914011111111', sipUri: 'sips:a@acd.example.com' },
    ])
      expect(
        parseWebhookResponse(canonical, 200, { status: 'accepted', destination }),
        JSON.stringify(destination),
      ).toEqual({ kind: 'invalid', reason: 'destination' });
  });
});

describe('checkDestination', () => {
  const policy = DestinationPolicy.parse({
    allowE164Prefixes: ['+9140', '+91801'],
    allowSipHosts: ['.acd.example.com', 'edge.example.net'],
    allowedHeaders: ['X-Acd-Ticket', 'X-Queue'],
  });
  const check = (answer: Parameters<typeof checkDestination>[1], p = policy) =>
    checkDestination(p, answer);

  it('allows an E.164 number under an allowed prefix', () => {
    expect(check({ e164: '+914012345678' })).toEqual({
      ok: true,
      target: { kind: 'phone', e164: '+914012345678' },
    });
    expect(check({ e164: '+918011234567', headers: { 'X-Acd-Ticket': '1' } })).toEqual({
      ok: true,
      target: { kind: 'phone', e164: '+918011234567' },
    });
  });

  it('refuses a number outside the prefixes or malformed', () => {
    expect(check({ e164: '+919800000000' })).toEqual({ ok: false, reason: 'e164_prefix' });
    expect(check({ e164: '+1900555012' })).toEqual({ ok: false, reason: 'e164_prefix' });
    for (const e164 of [
      '914012345678',
      '+40',
      '+9140123456789012',
      '+9140 1234567',
      '+9140123456a',
      '00914012345678',
    ])
      expect(check({ e164 }), e164).toEqual({ ok: false, reason: 'e164_format' });
  });

  it('refuses a missing or ambiguous destination', () => {
    expect(check({})).toEqual({ ok: false, reason: 'missing' });
    expect(check({ e164: '+914012345678', sipUri: 'sips:a@edge.example.net' })).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('allows a sips URI on an exact or suffix host and carries the listed headers only', () => {
    expect(
      check({
        sipUri: 'sips:agent7@pod1.acd.example.com:5061',
        headers: { 'x-acd-ticket': '123', 'X-Evil': 'x', 'X-Queue': 'vip' },
      }),
    ).toEqual({
      ok: true,
      target: {
        kind: 'sip',
        uri: 'sips:agent7@pod1.acd.example.com:5061',
        headers: { 'X-Acd-Ticket': '123', 'X-Queue': 'vip' },
      },
    });
    expect(check({ sipUri: 'sips:edge.example.net' })).toEqual({
      ok: true,
      target: { kind: 'sip', uri: 'sips:edge.example.net', headers: {} },
    });
    expect(check({ sipUri: 'SIPS:Agent@POD1.ACD.EXAMPLE.COM' }).ok).toBe(false);
    expect(check({ sipUri: 'sips:a@Pod1.Acd.Example.Com' }).ok).toBe(true);
  });

  it('refuses a host outside the allow-list, including the apex of a suffix entry and look-alikes', () => {
    for (const sipUri of [
      'sips:a@acd.example.com',
      'sips:a@evil.com',
      'sips:a@acd.example.com.evil.com',
      'sips:a@xacd.example.com',
      'sips:a@edge.example.net.evil.io',
      'sips:a@sub.edge.example.net',
    ])
      expect(check({ sipUri }), sipUri).toEqual({ ok: false, reason: 'sip_host' });
  });

  it('requires sips unless the queue relaxed it', () => {
    expect(check({ sipUri: 'sip:a@pod1.acd.example.com' })).toEqual({
      ok: false,
      reason: 'sip_scheme',
    });
    expect(
      check({ sipUri: 'sip:a@pod1.acd.example.com' }, { ...policy, allowInsecureSip: true }).ok,
    ).toBe(true);
  });

  it('refuses URIs that carry parameters, headers, passwords, whitespace or other schemes', () => {
    for (const sipUri of [
      'sips:a@pod1.acd.example.com;transport=udp',
      'sips:a@pod1.acd.example.com?Route=sip:evil.com',
      'sips:a:secret@pod1.acd.example.com',
      'sips:a@pod1.acd.example.com\r\nX-Evil: 1',
      'sips:a@pod1.acd.example.com, sips:b@evil.com',
      'sips:a@pod1.acd.example.com>',
      'sips:<a@pod1.acd.example.com>',
      'sips: a@pod1.acd.example.com',
      'tel:+914012345678',
      'http://pod1.acd.example.com',
      'sips:',
      'sips:a@',
      'sips:a@pod1.acd.example.com:99999',
      'sips:a@pod1.acd.example.com:0',
      'sips:a@pod1.acd.example.com:80x',
      'sips:[::1]',
    ])
      expect(check({ sipUri }), JSON.stringify(sipUri)).toEqual({
        ok: false,
        reason: 'sip_uri_invalid',
      });
  });

  it('refuses a listed header whose value is unprintable or oversize, and drops the rest', () => {
    for (const value of ['line\r\nbreak', 'tab\there', 'é', 'x'.repeat(257)])
      expect(
        check({ sipUri: 'sips:a@pod1.acd.example.com', headers: { 'X-Acd-Ticket': value } }),
        JSON.stringify(value),
      ).toEqual({ ok: false, reason: 'header_value' });
    expect(
      check({
        sipUri: 'sips:a@pod1.acd.example.com',
        headers: { Via: 'x', From: 'y', 'X-Other': '\r\n' },
      }),
    ).toEqual({
      ok: true,
      target: { kind: 'sip', uri: 'sips:a@pod1.acd.example.com', headers: {} },
    });
    expect(
      check({ sipUri: 'sips:a@pod1.acd.example.com', headers: { 'X-Acd-Ticket': 'x'.repeat(256) } })
        .ok,
    ).toBe(true);
  });
});
