import { describe, expect, it } from 'vitest';
import type { DestinationPolicy, WebhookSpec } from '../src/human-contract.ts';
import {
  cancelledWebhookBody,
  canonicalWebhookBody,
  checkDestination,
  parseWebhookResponse,
  renderBody,
  type HumanQueueContext,
} from '../src/human-wire.ts';

const context: HumanQueueContext = {
  call: { id: 'call-1', direction: 'inbound', startedAt: '2026-10-15T10:00:00.000Z' },
  caller: { number: '+919800001234' },
  route: { path: ['intent', 'billing'], language: 'hi', intent: 'billing' },
  handover: { summary: 'Wants a refund', transcript: [{ role: 'caller', text: 'refund please' }] },
  variables: { account_id: 'A-1', tier: 'gold' },
  queue: { key: 'support-desk', id: 'q-1', name: 'Support desk' },
  ticket: {
    id: 't-1',
    idempotencyKey: 'hq:ws:job:1',
    priority: 1,
    callbackUrl: 'https://ovo.example.test/api/v1/human-queue/callbacks/t-1',
    contextUrl: 'https://ovo.example.test/api/v1/human-queue/context/t-1?t=x',
    expiresAt: '2026-10-15T10:03:00.000Z',
  },
  time: { now: '2026-10-15T10:00:05.000Z' },
};

describe('the field mapping (human queue design 4.2)', () => {
  it('reads paths, defaults, caps, casts and templates, and unknown paths render empty', () => {
    const { body, contentType } = renderBody(
      {
        callId: { $from: 'call.id' },
        ani: { $from: 'caller.number', default: '' },
        city: { $from: 'caller.city', default: 'n/a' },
        short: { $from: 'handover.summary', maxChars: 5 },
        prio: { $from: 'ticket.priority', as: 'string' },
        vip: { $from: 'variables.tier', as: 'json' },
        notes: {
          $template: 'Intent {{route.intent}} for {{variables.account_id}} {{nope.nothing}}.',
        },
        nested: { list: [{ $from: 'queue.key' }, 'literal', 3, true, null] },
      },
      context,
      'json',
    );
    expect(contentType).toBe('application/json');
    expect(JSON.parse(body)).toEqual({
      callId: 'call-1',
      ani: '+919800001234',
      city: 'n/a',
      short: 'Wants',
      prio: '1',
      vip: '"gold"',
      notes: 'Intent billing for A-1 .',
      nested: { list: ['support-desk', 'literal', 3, true, null] },
    });
  });

  it('renders a flat mapping as a form', () => {
    const { body, contentType } = renderBody(
      { id: { $from: 'ticket.id' }, lang: { $from: 'route.language' } },
      context,
      'form',
    );
    expect(contentType).toBe('application/x-www-form-urlencoded');
    expect(body).toBe('id=t-1&lang=hi');
  });

  it('is the canonical ovo.human-queue/1 body without a mapping, and only what the context has', () => {
    const body = canonicalWebhookBody(context) as Record<string, any>;
    expect(body).toMatchObject({
      schema: 'ovo.human-queue/1',
      event: 'handoff',
      ticket: { id: 't-1', idempotencyKey: 'hq:ws:job:1' },
      queue: { key: 'support-desk', name: 'Support desk' },
      links: { context: expect.stringContaining('/context/t-1') },
    });
    const minimal = canonicalWebhookBody({
      queue: context.queue,
      ticket: { ...context.ticket, contextUrl: undefined },
      time: context.time,
    }) as Record<string, unknown>;
    for (const absent of ['caller', 'call', 'route', 'handover', 'variables', 'links'])
      expect(minimal).not.toHaveProperty(absent);
    expect(cancelledWebhookBody(context)).toEqual({
      schema: 'ovo.human-queue/1',
      event: 'cancelled',
      ticket: { id: 't-1', idempotencyKey: 'hq:ws:job:1' },
      queue: { key: 'support-desk', name: 'Support desk' },
    });
  });
});

const spec = (response: Partial<WebhookSpec['response']> = {}): WebhookSpec =>
  ({
    response: {
      acceptedValues: ['accepted', 'ok'],
      queuedValues: ['queued'],
      rejectedValues: ['rejected'],
      ...response,
    },
  }) as WebhookSpec;

describe("the third party's answer (design 4.2.1)", () => {
  it('reads the canonical response', () => {
    expect(
      parseWebhookResponse(spec(), {
        status: 'accepted',
        ticketRef: 'acd-1',
        destination: { sipUri: 'sips:a@acd.example.com', headers: { 'X-A': '1', 'X-B': 2 } },
      }),
    ).toEqual({
      kind: 'accepted',
      ticketRef: 'acd-1',
      destination: { sipUri: 'sips:a@acd.example.com', headers: { 'X-A': '1' } },
    });
    expect(parseWebhookResponse(spec(), { status: 'queued' })).toEqual({ kind: 'queued' });
    expect(parseWebhookResponse(spec(), { status: 'rejected', reason: 'closed' })).toEqual({
      kind: 'rejected',
      reason: 'closed',
    });
  });

  it('reads a mapped response through JSON pointers and the queue status sets', () => {
    const mapped = spec({
      statusPath: '/result/state',
      acceptedValues: ['ok'],
      destinationE164Path: '/dial/number',
      ticketRefPath: '/ref',
    });
    expect(
      parseWebhookResponse(mapped, {
        result: { state: 'ok' },
        dial: { number: '+914012345678' },
        ref: 'r1',
      }),
    ).toEqual({ kind: 'accepted', destination: { e164: '+914012345678' }, ticketRef: 'r1' });
  });

  it('calls anything it cannot use invalid, never throws', () => {
    expect(parseWebhookResponse(spec(), 'text')).toEqual({ kind: 'invalid', reason: 'json' });
    expect(parseWebhookResponse(spec(), null)).toEqual({ kind: 'invalid', reason: 'json' });
    expect(parseWebhookResponse(spec(), {})).toEqual({ kind: 'invalid', reason: 'status' });
    expect(parseWebhookResponse(spec(), { status: 'maybe' })).toEqual({
      kind: 'invalid',
      reason: 'status',
    });
    expect(parseWebhookResponse(spec(), { status: 'accepted' })).toEqual({
      kind: 'invalid',
      reason: 'destination',
    });
  });
});

describe('the destination policy (toll-fraud guard, design 11)', () => {
  const policy: DestinationPolicy = {
    allowE164Prefixes: ['+9140', '+91801'],
    allowSipHosts: ['acd.example.com', '.pool.example.com'],
    allowInsecureSip: false,
    allowedHeaders: ['X-Acd-Ticket'],
  };

  it('allows a number by prefix and refuses the rest', () => {
    expect(checkDestination(policy, { e164: '+914012345678' })).toEqual({
      ok: true,
      target: { kind: 'phone', e164: '+914012345678' },
    });
    expect(checkDestination(policy, { e164: '+919999999999' })).toEqual({
      ok: false,
      reason: 'e164_prefix',
    });
    expect(checkDestination(policy, { e164: '4012345678' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(checkDestination(policy, { e164: '+914012345678;phone-context=x' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('allows a SIP URI on an allowed host over sips, with only the allow-listed, printable headers', () => {
    const result = checkDestination(policy, {
      sipUri: 'sips:agent7@a.pool.example.com:5061',
      headers: {
        'x-acd-ticket': '123',
        'X-Evil': 'nope',
        'X-Acd-Ticket-2': 'x',
      },
    });
    expect(result).toEqual({
      ok: true,
      target: {
        kind: 'sip',
        uri: 'sips:agent7@a.pool.example.com:5061',
        headers: { 'X-Acd-Ticket': '123' },
      },
    });
    expect(
      checkDestination(policy, {
        sipUri: 'sips:x@acd.example.com',
        headers: { 'X-Acd-Ticket': 'bad\r\nValue' },
      }),
    ).toMatchObject({ ok: true, target: { headers: {} } });
  });

  it('refuses plain sip, an unlisted host, a lookalike host, and two destinations', () => {
    expect(checkDestination(policy, { sipUri: 'sip:a@acd.example.com' })).toEqual({
      ok: false,
      reason: 'sip_scheme',
    });
    expect(
      checkDestination({ ...policy, allowInsecureSip: true }, { sipUri: 'sip:a@acd.example.com' })
        .ok,
    ).toBe(true);
    for (const sipUri of [
      'sips:a@evil.example.net',
      'sips:a@acd.example.com.evil.net',
      'sips:a@xpool.example.com',
    ])
      expect(checkDestination(policy, { sipUri })).toEqual({ ok: false, reason: 'sip_host' });
    expect(
      checkDestination(policy, { e164: '+914012345678', sipUri: 'sips:a@acd.example.com' }),
    ).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
    expect(checkDestination(policy, {})).toEqual({ ok: false, reason: 'none' });
    expect(checkDestination(policy, { sipUri: 'sips:a@acd.example.com?Route=<sip:evil>' })).toEqual(
      {
        ok: false,
        reason: 'malformed',
      },
    );
  });
});
