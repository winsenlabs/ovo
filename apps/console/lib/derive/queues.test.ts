import { describe, expect, it } from 'vitest';
import {
  availableContextFields,
  blankQueue,
  EXTERNAL_CONTEXT,
  hoursSummary,
  isReservedHeader,
  issueAt,
  kindLabel,
  MANAGED_CONTEXT,
  queueKpis,
  setIn,
  unclaimedIssues,
} from './queues';
import type { QueueRecord } from '../types/queues';

describe('blankQueue', () => {
  it('starts an external queue with the contract defaults and an empty allow-list', () => {
    const queue = blankQueue('external');
    if (queue.kind !== 'external') throw new Error('kind');
    expect(queue.webhook.retry).toEqual({ attempts: 3, baseMs: 500, maxMs: 5_000, deadlineMs: 15_000 });
    expect(queue.webhook.method).toBe('POST');
    expect(queue.destination.allowE164Prefixes).toEqual([]);
    expect(queue.context).toEqual(EXTERNAL_CONTEXT);
    expect(queue.context.callerId).toBe(false);
    expect(queue.callbackWindowHours).toBe(24);
  });

  it('starts a desk queue open to every eligible operator, transcribing, ending the call on leave', () => {
    const queue = blankQueue('managed');
    if (queue.kind !== 'managed') throw new Error('kind');
    expect(queue).toMatchObject({
      assignment: 'OPEN_PICKUP',
      language: 'prefer',
      offerSeconds: 20,
      joinSeconds: 25,
      requireOnline: true,
      onOperatorLeave: 'end_call',
      ai: { mode: 'transcribe', transcribeOperator: true },
    });
    expect(queue.context).toEqual(MANAGED_CONTEXT);
  });

  it('never shares nested state between two blanks', () => {
    const a = blankQueue('managed');
    const b = blankQueue('managed');
    expect(setIn(a, 'wrapUp.required', true)).not.toBe(a);
    expect(b).toMatchObject({ wrapUp: { required: false } });
  });
});

describe('setIn', () => {
  it('copies along the path and leaves the original untouched', () => {
    const original = { webhook: { retry: { attempts: 3 }, url: 'a' }, name: 'n' };
    const next = setIn(original, 'webhook.retry.attempts', 5);
    expect(next.webhook.retry.attempts).toBe(5);
    expect(original.webhook.retry.attempts).toBe(3);
    expect(next.webhook.url).toBe('a');
  });
  it('creates the objects on the way', () => {
    expect(setIn({} as { a?: { b?: number } }, 'a.b', 1)).toEqual({ a: { b: 1 } });
  });
});

describe('issues', () => {
  const issues = [
    { path: ['webhook', 'url'], message: 'Must be https' },
    { path: ['destination', 'allowE164Prefixes'], message: 'Add at least one prefix' },
    { path: [], message: 'General' },
  ];
  it('finds the message at a dotted path', () => {
    expect(issueAt(issues, 'webhook.url')).toBe('Must be https');
    expect(issueAt(issues, 'name')).toBeUndefined();
  });
  it('lists the issues no field claims', () => {
    expect(unclaimedIssues(issues, ['webhook.url', 'destination'])).toEqual([issues[2]]);
  });
});

describe('summaries', () => {
  it('describes hours in one line', () => {
    expect(hoursSummary(undefined)).toBe('Always open');
    expect(hoursSummary({ timezone: 'Asia/Kolkata', weekly: {}, closed: [] })).toBe('Closed');
    expect(
      hoursSummary({
        timezone: 'Asia/Kolkata',
        weekly: { mon: [{ start: '09:00', end: '18:00' }], tue: [{ start: '09:00', end: '18:00' }] },
        closed: [],
      }),
    ).toBe('2 days, 09:00–18:00 Asia/Kolkata');
  });
  it('names the two kinds the way the console says them', () => {
    expect(kindLabel('external')).toBe('Webhook');
    expect(kindLabel('managed')).toBe('Operator desk');
  });
  it('totals waiting callers and takes the most operators online', () => {
    const row = (waiting: number, offered: number, online: number) =>
      ({ stats: { waiting, offered, online, oldestWaitMs: 0, handled24h: 0 } }) as QueueRecord;
    expect(queueKpis([row(2, 1, 3), row(0, 0, 5)])).toEqual({ queues: 2, waiting: 3, online: 5 });
    expect(queueKpis([])).toEqual({ queues: 0, waiting: 0, online: 0 });
  });
});

describe('mapping helpers', () => {
  it('offers only fields the context policy can supply', () => {
    const paths = availableContextFields(EXTERNAL_CONTEXT).map((field) => field.path);
    expect(paths).not.toContain('caller.number');
    expect(paths).toContain('route.language');
    expect(availableContextFields({ ...EXTERNAL_CONTEXT, callerId: true }).map((f) => f.path)).toContain('caller.number');
  });
  it('treats framing, auth and OVO headers as reserved, case-insensitively', () => {
    expect(isReservedHeader('Authorization')).toBe(true);
    expect(isReservedHeader('X-OVO-Ticket')).toBe(true);
    expect(isReservedHeader('Idempotency-Key')).toBe(true);
    expect(isReservedHeader('X-Acd-Region')).toBe(false);
  });
});
