import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { afterEach, describe, expect, it } from 'vitest';
import { type HqApp, humanQueueApp, useHq } from './human-queue-fixtures.ts';
import { external, makeQueue, managed } from './human-queue-data.ts';

const make = useHq(fakeMediaRoom);

const POLICY = {
  callerId: false,
  calledNumber: false,
  language: true,
  intent: true,
  summary: true,
  transcriptTurns: 0,
  transcriptLink: true,
  variables: ['account_id'],
  summarize: 'agent_only',
};

describe('POST /v1/human-queues/preview', () => {
  it('renders the canonical body when no mapping is given, with only what the policy allows', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues/preview', {
      role: 'editor',
      payload: { spec: {}, policy: POLICY },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { body, issues } = response.json();
    expect(issues).toEqual([]);
    expect(body).toMatchObject({ schema: 'ovo.human-queue/1', event: 'handoff', test: true });
    expect(body.caller).toBeUndefined();
    expect(body.variables).toEqual({ account_id: 'sample' });
    expect(body.handover.transcript).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('+1555');
  });

  it('renders a mapping, drops fields the policy switches off, and reports them as issues', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues/preview', {
      payload: {
        spec: {
          body: {
            callId: { $from: 'call.id' },
            ani: { $from: 'caller.number', default: '' },
            note: { $template: 'Intent {{route.intent}}' },
          },
        },
        policy: POLICY,
      },
    });
    const { body, issues } = response.json();
    expect(body).toEqual({ callId: 'call-test', ani: '', note: 'Intent billing' });
    expect(issues.map((i: { code: string }) => i.code)).toEqual([
      'routing_queue_mapping_field_disabled',
    ]);
    expect(issues[0].path.slice(0, 2)).toEqual(['body', 'ani']);
  });

  it('shows the caller number of the synthetic call only when the policy allows it', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues/preview', {
      payload: {
        spec: { body: { ani: { $from: 'caller.number' } } },
        policy: { ...POLICY, callerId: true },
      },
    });
    expect(response.json().body.ani).toBe('+15550100');
  });

  it('renders a flat body for the form format', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues/preview', {
      payload: {
        spec: { format: 'form', body: { a: { $from: 'call.id' }, b: { $from: 'route.language' } } },
        policy: POLICY,
      },
    });
    expect(response.json().body).toEqual({ a: 'call-test', b: 'en' });
  });

  it('previews a half-typed form: no URL or credential yet', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues/preview', {
      payload: {
        spec: { url: '', credentialId: '', auth: { kind: 'bearer', credentialId: '' }, body: {} },
        policy: POLICY,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().issues).toEqual([]);
  });

  it('reports a malformed spec as issues, not as a failure', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues/preview', {
      payload: { spec: { retry: { attempts: 99 } }, policy: POLICY },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().issues[0].path.join('.')).toBe('retry.attempts');
  });

  it('answers 422 for an invalid policy or envelope, and needs an editor', async () => {
    const hq = make();
    expect(
      (
        await hq.call('POST', '/v1/human-queues/preview', {
          payload: { spec: {}, policy: { callerId: 'yes' } },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await hq.call('POST', '/v1/human-queues/preview', { payload: { policy: POLICY, extra: 1 } }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await hq.call('POST', '/v1/human-queues/preview', {
          role: 'viewer',
          payload: { spec: {}, policy: POLICY },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('touches no network and no ticket', async () => {
    const hq = make();
    await hq.call('POST', '/v1/human-queues/preview', { payload: { spec: {}, policy: POLICY } });
    expect(hq.egress.sent).toEqual([]);
    expect(await hq.service.tickets.listForOperator('x', 'queue')).toEqual([]);
  });
});

describe('POST /v1/human-queues/:id/test-webhook', () => {
  async function webhookQueue(hq: HqApp, patch: Record<string, unknown> = {}) {
    return makeQueue(hq, external(patch));
  }

  it('sends a synthetic request through the client and returns it redacted, with each attempt and the answer', async () => {
    const hq = make();
    const queue = await webhookQueue(hq, {
      webhook: {
        url: 'https://acd.example.com/h?token=abc',
        credentialId: 'acd-hmac',
        auth: { kind: 'bearer', credentialId: 'acd-key' },
        headers: { 'X-Region': 'in' },
      },
    });
    hq.egress.script.push({
      attempts: [
        { attempt: 1, outcome: 'retry', status: 503, ms: 30, reason: 'http_503' },
        { attempt: 2, outcome: 'delivered', status: 200, ms: 25 },
      ],
      outcome: {
        ok: true,
        status: 200,
        json: { status: 'accepted', destination: { e164: '+9140555' } },
        attempts: 2,
      },
    });
    const response = await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.attempts.map((a: { outcome: string }) => a.outcome)).toEqual([
      'retry',
      'delivered',
    ]);
    expect(body.answer).toEqual({
      kind: 'accepted',
      destination: { e164: '+9140555' },
      destinationCheck: 'allowed',
    });
    expect(body.request.url).toBe('https://acd.example.com/h');
    expect(body.request.headers.authorization).toBe('<redacted>');
    expect(body.request.headers['X-Region']).toBe('in');
    expect(body.request.body).toMatchObject({ test: true, schema: 'ovo.human-queue/1' });
    // What went on the wire was signed with the resolved secret and carried the extra auth.
    const [sent] = hq.egress.sent;
    expect(sent).toMatchObject({
      secret: 'whsec-test',
      method: 'POST',
      idempotencyKey: expect.stringContaining('hq:test'),
    });
    expect(sent!.headers!.authorization).toBe('Bearer whsec-test');
    expect(JSON.stringify(body)).not.toContain('whsec-test');
    expect(hq.audits.at(-1)).toMatchObject({
      action: 'human_queue.test_webhook',
      resourceId: queue.id,
    });
  });

  it('uses synthetic data only: the fake caller, and nothing the policy switches off', async () => {
    const hq = make();
    const queue = await webhookQueue(hq);
    await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`);
    const text = hq.egress.sent[0]!.body;
    expect(text).toContain('"test":true');
    expect(text).not.toContain('+1555');
    const withCaller = await webhookQueue(hq, {
      context: {
        callerId: true,
        calledNumber: false,
        language: true,
        intent: true,
        summary: true,
        transcriptTurns: 0,
        transcriptLink: true,
        variables: [],
        summarize: 'agent_only',
      },
    });
    await hq.call('POST', `/v1/human-queues/${withCaller.id}/test-webhook`);
    expect(hq.egress.sent[1]!.body).toContain('+15550100');
  });

  it('tells a refused destination from an allowed one', async () => {
    const hq = make();
    const queue = await webhookQueue(hq);
    hq.egress.script.push({
      ok: true,
      status: 200,
      json: { status: 'accepted', destination: { e164: '+14155550100' } },
      attempts: 1,
    });
    const answer = (await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`)).json()
      .answer;
    expect(answer.destinationCheck).toBe('refused');
  });

  it('reports a delivery that failed, without an answer', async () => {
    const hq = make();
    const queue = await webhookQueue(hq);
    hq.egress.script.push({
      attempts: [{ attempt: 1, outcome: 'failed', ms: 3000, reason: 'timeout' }],
      outcome: { ok: false, reason: 'timeout', attempts: 1 },
    });
    const body = (await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`)).json();
    expect(body.failure).toBe('timeout');
    expect(body.answer).toBeUndefined();
    expect(body.attempts[0].reason).toBe('timeout');
  });

  it('reads a rejected or invalid answer as its own kind', async () => {
    const hq = make();
    const queue = await webhookQueue(hq);
    hq.egress.script.push({
      ok: true,
      status: 200,
      json: { status: 'rejected', reason: 'closed' },
      attempts: 1,
    });
    expect(
      (await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`)).json().answer,
    ).toEqual({ kind: 'rejected', reason: 'closed' });
    hq.egress.script.push({ ok: true, status: 200, json: { nonsense: true }, attempts: 1 });
    expect(
      (await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`)).json().answer,
    ).toEqual({ kind: 'invalid', reason: 'status' });
  });

  it('is admin only, external only and refuses while webhooks are switched off', async () => {
    const hq = make();
    const queue = await webhookQueue(hq);
    expect(
      (await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`, { role: 'editor' }))
        .statusCode,
    ).toBe(403);
    const desk = await makeQueue(hq, managed());
    const notExternal = await hq.call('POST', `/v1/human-queues/${desk.id}/test-webhook`);
    expect([notExternal.statusCode, notExternal.json().error.code]).toEqual([
      422,
      'queue_not_external',
    ]);
    expect(
      (await hq.call('POST', '/v1/human-queues/00000000-0000-4000-8000-000000000009/test-webhook'))
        .statusCode,
    ).toBe(404);
    const off = make({ webhookEnabled: false });
    const offQueue = await webhookQueue(off);
    const refused = await off.call('POST', `/v1/human-queues/${offQueue.id}/test-webhook`);
    expect([refused.statusCode, refused.json().error.code]).toEqual([503, 'webhook_disabled']);
    expect(off.egress.sent).toEqual([]);
  });

  it('is limited to ten a minute per person, and the window slides', async () => {
    const hq = make();
    const queue = await webhookQueue(hq);
    for (let i = 0; i < 10; i += 1)
      expect((await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`)).statusCode).toBe(
        200,
      );
    const limited = await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`);
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      (await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`, { user: 'other-admin' }))
        .statusCode,
    ).toBe(200);
    hq.service.clock.advance(61_000);
    expect((await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`)).statusCode).toBe(
      200,
    );
  });

  it('answers 422 when a credential the queue uses can no longer be resolved', async () => {
    const hq = make({ secretError: true });
    const queue = await webhookQueue(hq);
    const response = await hq.call('POST', `/v1/human-queues/${queue.id}/test-webhook`);
    expect([response.statusCode, response.json().error.code]).toEqual([
      422,
      'credential_unavailable',
    ]);
    expect(hq.egress.sent).toEqual([]);
  });
});
