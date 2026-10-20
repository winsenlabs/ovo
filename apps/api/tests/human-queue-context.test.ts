import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { describe, expect, it } from 'vitest';
import { type HqApp } from './human-queue-fixtures.ts';
import { callbackApps, setup } from './callback-support.ts';

const make = callbackApps(fakeMediaRoom);
describe('GET /v1/human-queue/context/:ticketId', () => {
  const link = async (hq: HqApp, ticketId: string, ttl = 900) =>
    `/v1/human-queue/context/${ticketId}?t=${await hq.service.tickets.issueContextToken(ticketId, ttl)}`;

  it('serves the policy-filtered context to the ticket’s bearer, uncached and with no session', async () => {
    const hq = make();
    const { ticket } = await setup(hq, {
      context: {
        callerId: false,
        calledNumber: false,
        language: true,
        intent: true,
        summary: true,
        transcriptTurns: 1,
        transcriptLink: true,
        variables: ['account'],
        summarize: 'agent_only',
      },
    });
    const response = await hq.app.inject({
      method: 'GET',
      url: await link(hq, ticket.id),
      headers: { 'x-anonymous': '1' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.caller).toEqual({});
    expect(body.variables).toEqual({ account: 'A1' });
    expect(body.transcript).toEqual([{ role: 'caller', text: 'three' }]);
    expect(body.returnTargets).toEqual([]);
    expect(body.summary).toBe('Caller asks about a charge.');
    expect(JSON.stringify(body)).not.toContain('9800000000');
  });

  it('shows the caller number and every turn only when the policy says so', async () => {
    const hq = make();
    const { ticket } = await setup(hq, {
      context: {
        callerId: true,
        calledNumber: true,
        language: true,
        intent: true,
        summary: false,
        transcriptTurns: 20,
        transcriptLink: true,
        variables: [],
        summarize: 'agent_only',
      },
    });
    const body = (await hq.app.inject({ method: 'GET', url: await link(hq, ticket.id) })).json();
    expect(body.caller).toEqual({ number: '+919800000000', calledNumber: '+918000000001' });
    expect(body.transcript).toHaveLength(3);
    expect(body.summary).toBeUndefined();
    expect(body.variables).toEqual({});
  });

  it('401 for a missing, wrong or other-ticket token', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const other = await setup(hq);
    expect(
      (await hq.app.inject({ method: 'GET', url: `/v1/human-queue/context/${ticket.id}` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await hq.app.inject({
          method: 'GET',
          url: `/v1/human-queue/context/${ticket.id}?t=${'a'.repeat(43)}`,
        })
      ).statusCode,
    ).toBe(401);
    await hq.service.tickets.issueContextToken(ticket.id, 900);
    const tokenOfOther = (await link(hq, other.ticket.id)).split('?t=')[1];
    expect(
      (
        await hq.app.inject({
          method: 'GET',
          url: `/v1/human-queue/context/${ticket.id}?t=${tokenOfOther}`,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('410 once the 15 minute link has expired, 404 for an unknown ticket', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const url = await link(hq, ticket.id, 900);
    expect((await hq.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    hq.service.clock.advance(901_000);
    const expired = await hq.app.inject({ method: 'GET', url });
    expect([expired.statusCode, expired.json().error.code]).toEqual([410, 'context_expired']);
    expect(
      (
        await hq.app.inject({
          method: 'GET',
          url: `/v1/human-queue/context/00000000-0000-4000-8000-000000000009?t=${'a'.repeat(43)}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('applies the strictest policy when the queue was deleted since', async () => {
    const hq = make();
    const { queue, ticket } = await setup(hq, {
      context: {
        callerId: true,
        calledNumber: true,
        language: true,
        intent: true,
        summary: true,
        transcriptTurns: 5,
        transcriptLink: true,
        variables: ['account'],
        summarize: 'agent_only',
      },
    });
    const url = await link(hq, ticket.id);
    await hq.service.queues.remove(queue.id, 1);
    const body = (await hq.app.inject({ method: 'GET', url })).json();
    expect(body.caller).toEqual({ number: '+919800000000', calledNumber: '+918000000001' });
  });

  it('429 when hammered, and 404 while the feature is off', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const url = await link(hq, ticket.id);
    for (let i = 0; i < 60; i += 1) await hq.app.inject({ method: 'GET', url });
    expect((await hq.app.inject({ method: 'GET', url })).statusCode).toBe(429);
    const off = make({ enabled: false });
    expect(
      (
        await off.app.inject({
          method: 'GET',
          url: `/v1/human-queue/context/00000000-0000-4000-8000-000000000009?t=${'a'.repeat(43)}`,
        })
      ).statusCode,
    ).toBe(404);
  });
});
