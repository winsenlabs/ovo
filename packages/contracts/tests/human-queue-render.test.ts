import { describe, expect, it } from 'vitest';
import {
  canonicalWebhookBody,
  encodeWebhookBody,
  readContextPath,
  renderMapping,
} from '../src/index.ts';
import { body, context, policy } from './human-queue-mapping-fixture.ts';

describe('readContextPath', () => {
  it('walks dotted paths and stops at arrays, missing keys and non-objects', () => {
    const c = context();
    expect(readContextPath(c, 'caller.number')).toBe('+919800000000');
    expect(readContextPath(c, 'route.context.tier')).toBe('gold');
    expect(readContextPath(c, 'variables.vip')).toBe(true);
    expect(readContextPath(c, 'route.path')).toEqual(['intent', 'billing']);
    expect(readContextPath(c, 'route.path.0')).toBeUndefined();
    expect(readContextPath(c, 'caller.nope')).toBeUndefined();
    expect(readContextPath(c, 'call.id.deeper')).toBeUndefined();
    expect(readContextPath({ ...c, caller: undefined }, 'caller.number')).toBeUndefined();
    expect(readContextPath(c, '__proto__.polluted')).toBeUndefined();
    expect(readContextPath(c, 'constructor.name')).toBeUndefined();
  });
});

describe('renderMapping', () => {
  it('renders refs, literals, nested objects and arrays', () => {
    const rendered = renderMapping(
      {
        callId: { $from: 'call.id' },
        fixed: 'always',
        count: 3,
        flag: true,
        nothing: null,
        nested: { lang: { $from: 'route.language' }, deeper: { n: { $from: 'ticket.priority' } } },
        list: [{ $from: 'queue.key' }, 'x', { $from: 'caller.nope' }],
      },
      context(),
      'json',
    );
    expect(rendered).toEqual({
      callId: 'job-1',
      fixed: 'always',
      count: 3,
      flag: true,
      nothing: null,
      nested: { lang: 'hi', deeper: { n: 1 } },
      list: ['support-desk', 'x', null],
    });
  });

  it('uses defaults for absent values, and omits a key with no default', () => {
    const c = context({ caller: undefined });
    expect(
      renderMapping(
        {
          ani: { $from: 'caller.number', default: '' },
          zero: { $from: 'caller.number', default: 0 },
          lost: { $from: 'caller.number' },
          kept: { $from: 'call.id' },
        },
        c,
        'json',
      ),
    ).toEqual({ ani: '', zero: 0, kept: 'job-1' });
  });

  it('clips with maxChars by code points, after conversion', () => {
    const c = context({ handover: { summary: 'héllo wörld 🙂🙂🙂' } });
    expect(
      renderMapping(
        {
          s: { $from: 'handover.summary', maxChars: 5 },
          e: { $from: 'handover.summary', maxChars: 13 },
          d: { $from: 'caller.nope', default: 'abcdefgh', maxChars: 3 },
          n: { $from: 'ticket.priority', as: 'string', maxChars: 1 },
        },
        c,
        'json',
      ),
    ).toMatchObject({ s: 'héllo', e: 'héllo wörld 🙂', d: 'abc', n: '1' });
  });

  it('converts with `as`', () => {
    expect(
      renderMapping(
        {
          num: { $from: 'ticket.priority', as: 'number' },
          str: { $from: 'ticket.priority', as: 'string' },
          bad: { $from: 'call.id', as: 'number' },
          yes: { $from: 'variables.vip', as: 'boolean' },
          no: { $from: 'variables.age', as: 'boolean' },
          json: { $from: 'route.path', as: 'json' },
          flat: { $from: 'route.path', as: 'string' },
          raw: { $from: 'route.path' },
        },
        context(),
        'json',
      ),
    ).toEqual({
      num: 1,
      str: '1',
      bad: null,
      yes: true,
      no: false,
      json: ['intent', 'billing'],
      flat: '["intent","billing"]',
      raw: ['intent', 'billing'],
    });
  });

  it('renders templates: scalars as text, unknown and structured paths empty, maxChars applied', () => {
    const rendered = renderMapping(
      {
        a: { $template: 'Call from {{ caller.number }} about {{route.intent}}.' },
        b: { $template: '[{{caller.nope}}][{{route.path}}][{{variables.vip}}][{{variables.age}}]' },
        c: { $template: '{{handover.summary}}', maxChars: 6 },
        literal: '{{caller.number}}',
      },
      context(),
      'json',
    );
    expect(rendered).toEqual({
      a: 'Call from +919800000000 about billing.',
      b: '[][][true][4]',
      c: 'Caller',
      literal: '{{caller.number}}',
    });
  });

  it('never evaluates caller-derived text', () => {
    const c = context({ handover: { summary: '{{caller.number}} $from ${process.env.SECRET}' } });
    expect(renderMapping({ s: { $template: '{{handover.summary}}' } }, c, 'json')).toEqual({
      s: '{{caller.number}} $from ${process.env.SECRET}',
    });
  });

  it('omits what the context lacks, which is how a policy-off namespace renders nothing', () => {
    const c = context({ caller: undefined, handover: undefined });
    expect(
      renderMapping(
        {
          n: { $from: 'caller.number' },
          t: { $template: 'x{{caller.number}}{{handover.summary}}y' },
          s: { $from: 'handover.transcript' },
        },
        c,
        'json',
      ),
    ).toEqual({ t: 'xy' });
  });

  it('flattens to text for a form body', () => {
    expect(
      renderMapping(
        { a: { $from: 'call.id' }, n: 5, b: false, nul: null, arr: { $from: 'route.path' } },
        context(),
        'form',
      ),
    ).toEqual({ a: 'job-1', n: '5', b: 'false', nul: '', arr: '["intent","billing"]' });
  });

  it('exposes the cancel event to a mapping', () => {
    const cancelled = context({ ticket: { ...context().ticket, event: 'cancelled' } });
    const map = { event: { $from: 'ticket.event' } };
    expect(renderMapping(map, context(), 'json')).toEqual({ event: 'handoff' });
    expect(renderMapping(map, cancelled, 'json')).toEqual({ event: 'cancelled' });
  });

  it('does not mutate its inputs', () => {
    const map = { a: { $from: 'call.id' }, b: [{ $template: '{{queue.key}}' }] };
    const frozen = JSON.parse(JSON.stringify(map));
    renderMapping(map, context(), 'json');
    expect(map).toEqual(frozen);
  });
});

describe('canonical body and encoding', () => {
  it('renders ovo.human-queue/1 with only the sections the context carries', () => {
    expect(canonicalWebhookBody(context())).toEqual({
      schema: 'ovo.human-queue/1',
      event: 'handoff',
      ticket: {
        id: 't1',
        idempotencyKey: 'hq:org:job-1:1',
        priority: 1,
        expiresAt: '2026-10-15T09:03:00.000Z',
        callbackUrl: 'https://ovo.example.com/api/v1/human-queue/callbacks/t1',
      },
      queue: { key: 'support-desk', name: 'Support desk' },
      call: { id: 'job-1', direction: 'inbound', startedAt: '2026-10-15T09:00:00.000Z' },
      caller: { number: '+919800000000', calledNumber: '+914000000000' },
      route: { path: ['intent', 'billing'], language: 'hi', intent: 'billing' },
      handover: {
        summary: 'Caller disputes a charge.',
        reason: 'wants a person',
        transcript: [{ role: 'caller', text: 'I want a person' }],
      },
      variables: { account_id: 'A-77', vip: true, age: 4 },
      links: {
        context: 'https://ovo.example.com/api/v1/human-queue/context/t1?t=tok',
        transcript: 'https://ovo.example.com/api/v1/human-queue/transcript/t1?t=tok',
      },
    });
  });

  it('sends no caller and no transcript when the policy left them out', () => {
    const minimal = canonicalWebhookBody(
      context({
        caller: undefined,
        handover: { summary: 'S' },
        variables: undefined,
        route: { language: 'hi' },
      }),
    );
    expect(minimal).not.toHaveProperty('caller');
    expect(minimal).not.toHaveProperty('variables');
    expect(minimal.handover).toEqual({ summary: 'S' });
    expect(minimal.route).toEqual({ language: 'hi' });
    expect(JSON.stringify(minimal)).not.toContain('+9198');
  });

  it('marks a synthetic test body and a cancel post', () => {
    const body = canonicalWebhookBody(
      context({ test: true, ticket: { ...context().ticket, event: 'cancelled' } }),
    );
    expect(body).toMatchObject({ event: 'cancelled', test: true });
  });

  it('falls back to the canonical body when a queue has no mapping', () => {
    expect(renderMapping(undefined, context(), 'json')).toEqual(canonicalWebhookBody(context()));
  });

  it('encodes json and form bodies', () => {
    expect(encodeWebhookBody({ a: 1, b: { c: 'd' } }, 'json')).toEqual({
      contentType: 'application/json',
      body: '{"a":1,"b":{"c":"d"}}',
    });
    expect(encodeWebhookBody({ a: 'x y', b: 2, c: null }, 'form')).toEqual({
      contentType: 'application/x-www-form-urlencoded',
      body: 'a=x+y&b=2&c=',
    });
  });
});
