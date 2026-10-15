import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { describe, expect, it } from 'vitest';
import { WORKSPACE, type HqApp } from './human-queue-fixtures.ts';
import { external, makeQueue, openTicket, signedCallback } from './human-queue-data.ts';
import { SECRET, callbackApps, post, send, setup } from './callback-support.ts';

const make = callbackApps(fakeMediaRoom);
describe('POST /v1/human-queue/callbacks/:ticketId', () => {
  it('202 applied: records an accepted callback and adds it to the call, with no session', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const response = await send(hq, ticket.id, { event: 'accepted', ticketRef: 'acd-1' });
    expect([response.statusCode, response.json()]).toEqual([202, { result: 'applied' }]);
    const events = await hq.outcomes.listEvents(WORKSPACE, ticket.callId);
    expect(events.items.map((e) => [e.type, e.payload])).toEqual([
      [
        'human.state',
        expect.objectContaining({
          ticket: ticket.id,
          state: 'accepted',
          by: 'callback',
          callback: 'accepted',
        }),
      ],
    ]);
  });

  it('202 applied: a destination while the ticket waits is checked against the queue’s allow-list and stored', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const response = await send(hq, ticket.id, {
      event: 'destination',
      ticketRef: 'acd-7',
      destination: {
        sipUri: 'sips:agent7@pool.acd.example.com',
        headers: { 'X-Acd-Ticket': '123', 'X-Evil': 'no' },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    const stored = (await hq.service.tickets.get(ticket.id))!;
    expect(stored.destination).toEqual({
      sipUri: 'sips:agent7@pool.acd.example.com',
      headers: { 'X-Acd-Ticket': '123' },
    });
    expect(stored.externalRef).toBe('acd-7');
  });

  it('202 applied: released and outcome callbacks after the leg left are added to the finished call', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    await hq.service.tickets.markHandedOff(ticket.id);
    expect(
      (await send(hq, ticket.id, { event: 'released', reason: 'agent hung up' })).statusCode,
    ).toBe(202);
    expect((await send(hq, ticket.id, { event: 'outcome', outcome: 'answered' })).statusCode).toBe(
      202,
    );
    const events = (await hq.outcomes.listEvents(WORKSPACE, ticket.callId)).items;
    expect(events.map((e) => e.payload.callback)).toEqual(['released', 'outcome']);
    expect(events[1]!.payload).toMatchObject({ code: 'answered', by: 'callback' });
    expect((await hq.service.tickets.get(ticket.id))!.status).toBe('released');
  });

  it('a released callback while the caller still holds releases the ticket for the worker', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    expect((await send(hq, ticket.id, { event: 'released' })).statusCode).toBe(202);
    const after = (await hq.service.tickets.get(ticket.id))!;
    expect([after.status, after.releaseCode]).toEqual(['released', 'webhook_rejected']);
  });

  it('202 duplicate: the same event id changes nothing the second time', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const first = post(
      hq,
      ticket.id,
      { event: 'outcome', outcome: 'busy' },
      { eventId: 'evt-fixed' },
    );
    expect((await first.response).json().result).toBe('applied');
    const again = await send(
      hq,
      ticket.id,
      { event: 'outcome', outcome: 'busy' },
      { eventId: 'evt-fixed' },
    );
    expect([again.statusCode, again.json()]).toEqual([202, { result: 'duplicate' }]);
    expect((await hq.outcomes.listEvents(WORKSPACE, ticket.callId)).items).toHaveLength(1);
  });

  it('a replayed destination does not set a second one', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const body = { event: 'destination', destination: { e164: '+9140555' } };
    await send(hq, ticket.id, body, { eventId: 'evt-d' });
    expect(
      (
        await send(
          hq,
          ticket.id,
          { event: 'destination', destination: { e164: '+9140999' } },
          { eventId: 'evt-d2' },
        )
      ).statusCode,
    ).toBe(409);
    expect((await hq.service.tickets.get(ticket.id))!.destination).toEqual({ e164: '+9140555' });
  });

  it('401: a wrong signature, a stale timestamp, a missing header and a missing secret', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    for (const [label, response] of [
      [
        'wrong secret',
        await send(hq, ticket.id, { event: 'accepted' }, {}, 'someone-elses-secret'),
      ],
      [
        'stale',
        await send(hq, ticket.id, { event: 'accepted' }, { timestamp: hq.now() - 301_000 }),
      ],
      [
        'future',
        await send(hq, ticket.id, { event: 'accepted' }, { timestamp: hq.now() + 301_000 }),
      ],
    ] as const) {
      expect([label, response.statusCode, response.json().error.code]).toEqual([
        label,
        401,
        'invalid_signature',
      ]);
    }
    const unsigned = await hq.app.inject({
      method: 'POST',
      url: `/v1/human-queue/callbacks/${ticket.id}`,
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.statusCode).toBe(401);
    const signed = signedCallback(SECRET, { event: 'accepted' }, { now: hq.now() });
    const tampered = await hq.app.inject({
      method: 'POST',
      url: `/v1/human-queue/callbacks/${ticket.id}`,
      payload: signed.payload.replace('accepted', 'released'),
      headers: signed.headers,
    });
    expect(tampered.statusCode).toBe(401);
    const noSecret = make({ secretError: true });
    const other = await setup(noSecret);
    expect((await send(noSecret, other.ticket.id, { event: 'accepted' })).statusCode).toBe(401);
    expect(await hq.outcomes.listEvents(WORKSPACE, ticket.callId)).toMatchObject({ items: [] });
  });

  it('accepts a timestamp at the edge of the 300 second window', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    expect(
      (await send(hq, ticket.id, { event: 'accepted' }, { timestamp: hq.now() - 299_000 }))
        .statusCode,
    ).toBe(202);
  });

  it('401 when the signature covers another event id than the header says', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const signed = signedCallback(
      SECRET,
      { event: 'accepted' },
      { now: hq.now(), eventId: 'evt-a' },
    );
    const response = await hq.app.inject({
      method: 'POST',
      url: `/v1/human-queue/callbacks/${ticket.id}`,
      payload: signed.payload,
      headers: { ...signed.headers, 'x-ovo-event-id': 'evt-b' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('404: an unknown ticket, a malformed id and a desk queue’s ticket', async () => {
    const hq = make();
    await setup(hq);
    expect(
      (await send(hq, '00000000-0000-4000-8000-000000000009', { event: 'accepted' })).statusCode,
    ).toBe(404);
    expect((await send(hq, 'not-a-uuid', { event: 'accepted' })).statusCode).toBe(404);
    const desk = await makeQueue(hq, { kind: 'managed', name: 'Desk' });
    const managedTicket = await openTicket(hq, desk);
    const response = await send(hq, managedTicket.id, { event: 'accepted' });
    expect([response.statusCode, response.json().error.code]).toEqual([404, 'ticket_not_found']);
  });

  it('410: after the callback window closed', async () => {
    const hq = make();
    const { ticket } = await setup(
      hq,
      {},
      { callbackUntil: new Date(T() + 3_600_000).toISOString() },
    );
    expect((await send(hq, ticket.id, { event: 'outcome', outcome: 'answered' })).statusCode).toBe(
      202,
    );
    hq.service.clock.advance(3_700_000);
    const response = await send(hq, ticket.id, { event: 'outcome', outcome: 'completed' });
    expect([response.statusCode, response.json().error.code]).toEqual([
      410,
      'callback_window_closed',
    ]);
  });

  it('413: a body over 16 KiB', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const huge = { event: 'outcome', outcome: 'answered', reason: 'x'.repeat(20_000) };
    const response = await send(hq, ticket.id, huge);
    expect(response.statusCode).toBe(413);
  });

  it('422: a body that is not JSON, not the callback shape, or names another event id', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    const notJson = signedCallback(SECRET, 'not json', { now: hq.now() });
    expect(
      (
        await hq.app.inject({
          method: 'POST',
          url: `/v1/human-queue/callbacks/${ticket.id}`,
          payload: notJson.payload,
          headers: notJson.headers,
        })
      ).statusCode,
    ).toBe(422);
    const wrongShape = await send(hq, ticket.id, { event: 'explode' });
    expect([wrongShape.statusCode, wrongShape.json().error.code]).toEqual([
      422,
      'invalid_callback',
    ]);
    const extra = await send(hq, ticket.id, { event: 'accepted', surprise: true });
    expect(extra.statusCode).toBe(422);
    const mismatch = signedCallback(
      SECRET,
      JSON.stringify({ eventId: 'inside', event: 'accepted' }),
      { now: hq.now(), eventId: 'header' },
    );
    const mismatched = await hq.app.inject({
      method: 'POST',
      url: `/v1/human-queue/callbacks/${ticket.id}`,
      payload: mismatch.payload,
      headers: mismatch.headers,
    });
    expect(mismatched.statusCode).toBe(422);
    const noDestination = await send(hq, ticket.id, { event: 'destination' });
    expect(noDestination.statusCode).toBe(422);
  });

  it('422 destination_refused: a number or host outside the allow-list is never stored, and the attempt is recorded', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    for (const destination of [
      { e164: '+14155550100' },
      { sipUri: 'sips:a@evil.example.net' },
      { sipUri: 'sip:a@pool.acd.example.com' },
      { e164: '+9140555', sipUri: 'sips:a@pool.acd.example.com' },
    ]) {
      const response = await send(hq, ticket.id, { event: 'destination', destination });
      expect([response.statusCode, response.json().error.code]).toEqual([
        422,
        'destination_refused',
      ]);
    }
    expect((await hq.service.tickets.get(ticket.id))!.destination).toBeUndefined();
    expect((await hq.outcomes.listEvents(WORKSPACE, ticket.callId)).items).toEqual([]);
  });

  it('429: too many callbacks for one ticket in a minute', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    for (let i = 0; i < 60; i += 1)
      expect(
        (await send(hq, ticket.id, { event: 'accepted' }, { eventId: `evt-${i}` })).statusCode,
      ).toBe(202);
    const limited = await send(hq, ticket.id, { event: 'accepted' }, { eventId: 'evt-over' });
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'rate_limited']);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('404 human_queue_disabled while the feature is off, even for a signed call', async () => {
    const hq = make({ enabled: false });
    const response = await send(hq, '00000000-0000-4000-8000-000000000009', { event: 'accepted' });
    expect([response.statusCode, response.json().error.code]).toEqual([
      404,
      'human_queue_disabled',
    ]);
  });

  it('keeps the call log unchanged when the outcome store is unavailable, but still applies the callback', async () => {
    const hq = make();
    const { ticket } = await setup(hq);
    hq.outcomes.append = async () => {
      throw new Error('store down');
    };
    expect((await send(hq, ticket.id, { event: 'accepted' })).statusCode).toBe(202);
  });
});

const T = () => new Date('2026-10-15T09:00:00.000Z').getTime();
