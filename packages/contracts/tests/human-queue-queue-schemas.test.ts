import { describe, expect, it } from 'vitest';
import {
  DestinationPolicy,
  EXTERNAL_CONTEXT_DEFAULT,
  HUMAN_QUEUE_LIMITS,
  HumanQueueBinding,
  HumanQueueDefinition,
  MANAGED_CONTEXT_DEFAULT,
  QueueContextPolicy,
  QueueSnapshot,
  ResponseMapping,
  WebhookSpec,
} from '../src/index.ts';
import {
  externalQueue,
  externalQueueInput,
  managedQueueInput,
  QUEUE_EXT,
} from './human-queue-fixture.ts';

describe('human queue definitions', () => {
  it('parses the worked external queue and fills its defaults', () => {
    const queue = externalQueue();
    if (queue.kind !== 'external') throw new Error('external');
    expect(queue.limits).toEqual({ maxWaiting: 100 });
    expect(queue.callbackWindowHours).toBe(24);
    expect(queue.webhook).toMatchObject({
      method: 'POST',
      format: 'json',
      timeoutMs: 3_000,
      cancel: true,
    });
    expect(queue.webhook.response.queuedValues).toEqual(['queued', 'pending', 'waiting']);
    expect(queue.destination).toMatchObject({ allowInsecureSip: false });
  });

  it('defaults a managed queue to open pickup, transcribing AI and the managed context', () => {
    const queue = HumanQueueDefinition.parse({ kind: 'managed', name: 'Floor' });
    expect(queue).toMatchObject({
      assignment: 'OPEN_PICKUP',
      teamIds: [],
      language: 'prefer',
      offerSeconds: 20,
      joinSeconds: 25,
      requireOnline: true,
      ai: { mode: 'transcribe', transcribeOperator: true },
      onOperatorLeave: 'end_call',
      returnTargets: [],
      wrapUp: { required: false, dispositions: [] },
      limits: { maxWaiting: 100 },
    });
    expect((queue as { context: unknown }).context).toEqual(MANAGED_CONTEXT_DEFAULT);
  });

  it('defaults an external queue context to the minimum: no caller id, no transcript', () => {
    const input = externalQueueInput();
    delete input.context;
    const queue = HumanQueueDefinition.parse(input);
    expect((queue as { context: unknown }).context).toEqual(EXTERNAL_CONTEXT_DEFAULT);
    expect(EXTERNAL_CONTEXT_DEFAULT).toMatchObject({
      callerId: false,
      calledNumber: false,
      transcriptTurns: 0,
      variables: [],
    });
    expect(MANAGED_CONTEXT_DEFAULT).toMatchObject({
      callerId: true,
      transcriptTurns: 6,
      variables: 'declared',
    });
  });

  it('refuses an unknown kind, an unknown field and an external queue without its parts', () => {
    const ext = externalQueueInput();
    for (const bad of [
      { ...ext, kind: 'carrier' },
      { ...ext, surprise: true },
      { ...ext, webhook: undefined },
      { ...ext, destination: undefined },
      { ...managedQueueInput(), webhook: ext.webhook },
      { ...ext, name: '   ' },
      { ...ext, limits: { maxWaiting: 0 } },
      { ...ext, limits: { maxWaiting: HUMAN_QUEUE_LIMITS.maxWaiting + 1 } },
      { ...ext, callbackWindowHours: 169 },
    ])
      expect(HumanQueueDefinition.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(
        false,
      );
  });

  it('bounds the managed knobs', () => {
    const managed = managedQueueInput();
    for (const patch of [
      { offerSeconds: 4 },
      { offerSeconds: 121 },
      { joinSeconds: 4 },
      { joinSeconds: 121 },
      { assignment: 'ROUND_ROBIN' },
      { language: 'strict' },
      { teamIds: ['Not A Team'] },
      { teamIds: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { returnTargets: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { onOperatorLeave: 'transfer' },
      { ai: { mode: 'listen' } },
      { wrapUp: { required: true, dispositions: Array.from({ length: 21 }, (_, i) => `d${i}`) } },
    ])
      expect(
        HumanQueueDefinition.safeParse({ ...managed, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
  });

  it('keeps the queue hold to the R2 hold grammar', () => {
    const ext = externalQueueInput();
    ext.hold.maxSeconds = 4;
    expect(HumanQueueDefinition.safeParse(ext).success).toBe(false);
    ext.hold.maxSeconds = 901;
    expect(HumanQueueDefinition.safeParse(ext).success).toBe(false);
    ext.hold.maxSeconds = 900;
    expect(HumanQueueDefinition.safeParse(ext).success).toBe(true);
  });

  it('validates the context policy strictly', () => {
    const ok = { ...EXTERNAL_CONTEXT_DEFAULT, variables: ['account_id'] };
    expect(QueueContextPolicy.safeParse(ok).success).toBe(true);
    expect(QueueContextPolicy.safeParse({ ...ok, variables: 'declared' }).success).toBe(true);
    for (const bad of [
      { ...ok, transcriptTurns: 21 },
      { ...ok, transcriptTurns: -1 },
      { ...ok, variables: ['has space'] },
      { ...ok, variables: 'all' },
      { ...ok, variables: Array.from({ length: 21 }, (_, i) => `v${i}`) },
      { ...ok, summarize: 'always' },
      { ...ok, extra: 1 },
      { callerId: true },
    ])
      expect(QueueContextPolicy.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(
        false,
      );
  });

  it('pins a queue by value with its binding key and priority', () => {
    const snapshot = QueueSnapshot.parse({
      id: QUEUE_EXT,
      version: 3,
      key: 'support-desk',
      priority: 2,
      definition: externalQueue(),
    });
    expect(snapshot.definition.kind).toBe('external');
    expect(HumanQueueBinding.parse({ key: 'a', queueId: QUEUE_EXT }).priority).toBe(0);
    for (const bad of [
      { key: 'A', queueId: QUEUE_EXT },
      { key: 'a', queueId: 'not-a-uuid' },
      { key: 'a', queueId: QUEUE_EXT, priority: 10 },
      { key: 'a', queueId: QUEUE_EXT, extra: 1 },
    ])
      expect(HumanQueueBinding.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(QueueSnapshot.safeParse({ id: QUEUE_EXT, key: 'a', priority: 0 }).success).toBe(false);
  });
});

describe('webhook spec', () => {
  const spec = () => externalQueueInput().webhook;

  it('fills the design defaults for retry, response, auth and headers', () => {
    const parsed = WebhookSpec.parse({ url: 'https://acd.example.com/h', credentialId: 'c' });
    expect(parsed).toMatchObject({
      method: 'POST',
      format: 'json',
      auth: { kind: 'none' },
      headers: {},
      timeoutMs: 3_000,
      retry: { attempts: 3, baseMs: 500, maxMs: 5_000, deadlineMs: 15_000 },
      cancel: true,
    });
    expect(parsed.response.acceptedValues).toEqual(['accepted', 'ok', 'connected']);
    expect(parsed.response.rejectedValues).toContain('closed');
    expect(parsed.body).toBeUndefined();
  });

  it('bounds attempts, timeouts and the deadline', () => {
    for (const patch of [
      { timeoutMs: 199 },
      { timeoutMs: 10_001 },
      { retry: { attempts: 0 } },
      { retry: { attempts: 6 } },
      { retry: { baseMs: 99 } },
      { retry: { maxMs: 10_001 } },
      { retry: { deadlineMs: 999 } },
      { retry: { deadlineMs: 60_001 } },
      { method: 'GET' },
      { format: 'xml' },
      { url: 'not a url' },
      { url: `https://x.example.com/${'a'.repeat(2_048)}` },
      { credentialId: '' },
      { extra: true },
    ])
      expect(WebhookSpec.safeParse({ ...spec(), ...patch }).success, JSON.stringify(patch)).toBe(
        false,
      );
  });

  it('refuses malformed auth and header names', () => {
    for (const patch of [
      { auth: { kind: 'bearer' } },
      { auth: { kind: 'header', credentialId: 'c' } },
      { auth: { kind: 'header', name: 'bad name', credentialId: 'c' } },
      { auth: { kind: 'basic', credentialId: 'c' } },
      { headers: { 'bad name': 'v' } },
      { headers: { 'X-Ok': 'v'.repeat(257) } },
    ])
      expect(WebhookSpec.safeParse({ ...spec(), ...patch }).success, JSON.stringify(patch)).toBe(
        false,
      );
  });

  it('refuses response pointers that are not RFC 6901', () => {
    expect(ResponseMapping.safeParse({ statusPath: '/result/ok' }).success).toBe(true);
    for (const bad of ['result', '/has space', '/a?b', `/${'a'.repeat(200)}`])
      expect(ResponseMapping.safeParse({ statusPath: bad }).success, bad).toBe(false);
  });

  it('refuses mapping values that smuggle structure', () => {
    for (const body of [
      { $oops: 'x' },
      { a: { $from: 'nope nope' } },
      { a: { $from: 'caller.number', unknown: 1 } },
      { a: { $template: '' } },
      { a: { $template: 'x', extra: 1 } },
      { a: { $from: 'caller.number', as: 'xml' } },
      { 'has space': 'x' },
    ])
      expect(WebhookSpec.safeParse({ ...spec(), body }).success, JSON.stringify(body)).toBe(false);
  });
});

describe('destination policy', () => {
  it('is mandatory and non-empty on prefixes', () => {
    expect(DestinationPolicy.safeParse({}).success).toBe(false);
    expect(DestinationPolicy.safeParse({ allowE164Prefixes: [] }).success).toBe(false);
    const ok = DestinationPolicy.parse({ allowE164Prefixes: ['+91'] });
    expect(ok).toEqual({
      allowE164Prefixes: ['+91'],
      allowSipHosts: [],
      allowInsecureSip: false,
      allowedHeaders: [],
    });
  });

  it('accepts only well-formed prefixes, hosts and X- header names', () => {
    const base = { allowE164Prefixes: ['+91'] };
    for (const patch of [
      { allowE164Prefixes: ['91'] },
      { allowE164Prefixes: ['+0'] },
      { allowE164Prefixes: ['+12345678'] },
      { allowSipHosts: ['ACD.EXAMPLE.COM'] },
      { allowSipHosts: ['acd example.com'] },
      { allowSipHosts: ['*.example.com'] },
      { allowedHeaders: ['Authorization'] },
      { allowedHeaders: ['X-'] },
      { allowedHeaders: Array.from({ length: 17 }, (_, i) => `X-H${i}`) },
    ])
      expect(
        DestinationPolicy.safeParse({ ...base, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    expect(
      DestinationPolicy.safeParse({
        ...base,
        allowSipHosts: ['acd.example.com', '.example.net', '10.0.0.1'],
        allowedHeaders: ['X-Acd-Ticket'],
      }).success,
    ).toBe(true);
  });
});
