import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  findLiveKitBinary,
  startLiveKitServer,
  type TestServer,
} from '../../packages/plugin-room-livekit/src/testing.ts';
import {
  acceptTicket,
  addOperator,
  openStream,
  streamTickets,
  waitOffered,
  type Desk,
} from './support/desk-operator.ts';
import { humanStack, type HumanStack } from './support/human-setup.ts';
import { at, of, outcomeOf, pressWhenListening } from './support/human-call.ts';
import {
  CALLER_TONE_HZ,
  OPERATOR_TONE_HZ,
  callerHeardTone,
  joinAsOperator,
  roomsOf,
  tokenClaims,
  wavHasTone,
} from './support/room-audio.ts';
import { LINES } from './support/routing-setup.ts';
import { heard, receivedAudio, said, transferCall } from './support/transfer-call.ts';
import { TRANSFER_LINES } from './support/transfer-setup.ts';
import { HUMAN_LINES } from './support/human-setup.ts';
import { operatorApi } from './support/operator-setup.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('The human-room-path test needs OVO_TEST_POSTGRES_URL');
const binary = findLiveKitBinary(process.env.OVO_E2E_LIVEKIT_BIN);

describe.skipIf(!binary)('managed human queue with a real room server (R3)', () => {
  let server: TestServer;
  let env: HumanStack;
  let desk: Desk;
  beforeAll(async () => {
    server = await startLiveKitServer({ binary });
    env = await humanStack(postgresUrl!, net.routes, {
      room: server,
      line: { managed: true, external: false, recording: true },
    });
    desk = await addOperator(env, 'asha');
    await desk.presence('AVAILABLE');
  }, 180_000);
  afterAll(async () => {
    await env?.close();
    await server?.stop();
  });

  it('6. an operator answers in the browser: two-way audio, metered time, recorded, room cleaned up', async () => {
    const stream = await openStream(desk);
    const api = operatorApi(env.stack.operator);
    let ticketId = '';
    let grantToken = '';
    let roomName = '';
    const result = await transferCall(
      env,
      async (call) => {
        await heard(env, call, LINES.greeting);
        call.tone(CALLER_TONE_HZ);
        await pressWhenListening(env, call, '3');
        const [ticket] = await waitOffered(desk);
        ticketId = ticket!.id;
        expect(ticket).toMatchObject({
          status: 'offered',
          kind: 'managed',
          queueKey: 'floor',
          offeredToMe: true,
        });
        // Lists mask the caller's number; the stream carried the same offer.
        expect(ticket!.callerMasked).toMatch(/\*/);
        expect(JSON.stringify(ticket)).not.toContain('9800000001');
        await vi.waitFor(
          () =>
            expect(
              streamTickets(stream).some((t) => t.id === ticketId && t.status === 'offered'),
            ).toBe(true),
          { timeout: 10_000 },
        );
        const accepted = await acceptTicket(desk, ticket as never);
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        const grant = accepted.body.room;
        grantToken = grant.token;
        // One room per accept: its name carries the version the accept produced.
        roomName = grant.roomName;
        expect(roomName).toBe(`ovo-hq-${ticketId}-${ticket.version + 1}`);
        // The grant: this room, this operator, microphone only, no admin, a short life.
        expect(grant).toMatchObject({
          provider: 'livekit',
          roomName,
          identity: `op:${desk.id}`,
          role: 'operator',
        });
        const claims = await tokenClaims(server, grant.token);
        expect(claims.identity).toBe(`op:${desk.id}`);
        expect(claims.grant).toMatchObject({
          room: roomName,
          roomJoin: true,
          canPublish: true,
          canPublishSources: ['microphone'],
          canSubscribe: true,
          roomAdmin: false,
          roomCreate: false,
          roomList: false,
          hidden: false,
        });
        expect(claims.exp! - Date.now() / 1000).toBeLessThanOrEqual(121);
        // The assigned operator sees the full number; a repeat of the accept is the same ticket.
        expect(accepted.body.context.caller.number).toBe('+919800000001');
        const again = await acceptTicket(desk, ticket as never);
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(again.body.ticket.id).toBe(ticketId);
        expect((await tokenClaims(server, again.body.room.token)).identity).toBe(`op:${desk.id}`);

        const operator = await joinAsOperator({ serverUrl: grant.serverUrl, token: grant.token });
        operator.speak(OPERATOR_TONE_HZ);
        // Two-way audio: the operator hears the caller's tone, the caller the operator's.
        await vi.waitFor(() => expect(operator.heard(CALLER_TONE_HZ)).toBe(true), {
          timeout: 20_000,
          interval: 250,
        });
        await vi.waitFor(
          () => expect(callerHeardTone(receivedAudio(call), OPERATOR_TONE_HZ)).toBe(true),
          { timeout: 20_000, interval: 250 },
        );
        expect(operator.heard(OPERATOR_TONE_HZ), 'the operator hears only the caller').toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const ended = await desk.call('POST', `/v1/desk/tickets/${ticketId}/commands`, {
          kind: 'end_call',
        });
        expect(ended.status).toBe(202);
        await vi.waitFor(() => expect(operator.disconnected).toBe(true), { timeout: 20_000 });
        await operator.disconnect();
      },
      { carrier: 'hangup' },
    );
    const { events } = result;
    const requested = at(events, 'human.requested', { kind: 'managed', queue: 'floor' });
    const waiting = at(events, 'human.state', { state: 'waiting' });
    const connected = at(events, 'human.state', { state: 'connected', operator: desk.id });
    const segment = at(events, 'route.segment', { role: 'human', kind: 'managed' });
    const released = at(events, 'human.state', { state: 'released', code: 'ended_by_operator' });
    const completed = at(events, 'human.completed', { outcome: 'ended', operator: desk.id });
    const ended = at(events, 'segment.ended', { role: 'human', ended: 'operator_end' });
    const outcome = at(events, 'call.outcome', { outcome: 'completed' });
    expect(
      [requested, waiting, connected, segment, released, completed, ended, outcome].every(
        (position, index, all) => index === 0 || position > all[index - 1]!,
      ),
    ).toBe(true);
    // Billing: operator and room seconds ride the segment, the room outlasting the operator.
    const usage = events[ended]!.payload.usage as Record<string, number>;
    expect(usage['ovo.human.operator_seconds']).toBeGreaterThan(0);
    expect(usage['ovo.human.room_seconds']).toBeGreaterThanOrEqual(
      usage['ovo.human.operator_seconds']!,
    );
    expect(result.summary.human).toMatchObject({
      kind: 'managed',
      outcome: 'ended',
      operator: desk.id,
      connected: 1,
      requested: 1,
    });
    const segments = await api<{
      segments: Record<string, any>[];
      human: Record<string, any>;
    }> // eslint-disable-line @typescript-eslint/no-explicit-any
    ('GET', `/v1/calls/${result.jobId}/segments`);
    expect(segments.segments.map((s) => s.role)).toEqual(['router', 'human']);
    expect(segments.segments[1]!.human).toMatchObject({
      queue: 'floor',
      outcome: 'ended',
      operator: desk.id,
    });
    expect(segments.human).toMatchObject({ outcome: 'ended' });
    // The desk stream followed the ticket to its end.
    const statuses = streamTickets(stream)
      .filter((t) => t.id === ticketId)
      .map((t) => t.status);
    expect(statuses).toEqual(expect.arrayContaining(['offered', 'accepted']));
    stream.close();
    // The recording holds both sides: the caller's tone inbound, the operator's outbound.
    let recording: { id: string; state: string } | undefined;
    await vi.waitFor(
      async () => {
        const list = await api<{ items: { id: string; state: string }[] }>(
          'GET',
          `/v1/calls/${result.jobId}/live-recordings`,
        );
        recording = list.items[0];
        expect(recording?.state).toBe('available');
      },
      { timeout: 20_000, interval: 500 },
    );
    const track = async (name: 'inbound' | 'outbound') => {
      const response = await env.stack.operator.app.inject({
        method: 'GET',
        url: `/v1/calls/${result.jobId}/live-recordings/${recording!.id}/audio/${name}`,
        remoteAddress: '172.29.240.10',
        headers: { 'x-forwarded-proto': 'https', cookie: env.stack.operator.cookie },
      });
      expect(response.statusCode).toBe(200);
      return new Uint8Array(response.rawPayload);
    };
    expect(wavHasTone(await track('inbound'), CALLER_TONE_HZ)).toBe(true);
    expect(wavHasTone(await track('outbound'), OPERATOR_TONE_HZ)).toBe(true);
    // The room is gone from the server, and the grant no longer joins it.
    await vi.waitFor(
      async () =>
        expect((await roomsOf(server).listRooms()).map((room) => room.name)).not.toContain(
          roomName,
        ),
      { timeout: 15_000, interval: 500 },
    );
    await expect(joinAsOperator({ serverUrl: server.url, token: grantToken })).rejects.toThrow(
      /room does not exist/,
    );
    void outcomeOf;
    void of;
  });

  it('7. the operator sends the caller back to an agent, who takes over after a house-voice announcement', async () => {
    let ticketId = '';
    let operator!: Awaited<ReturnType<typeof joinAsOperator>>;
    let roomName = '';
    const result = await transferCall(env, async (call) => {
      await heard(env, call, LINES.greeting);
      await pressWhenListening(env, call, '3');
      const [ticket] = await waitOffered(desk);
      ticketId = ticket!.id;
      const accepted = await acceptTicket(desk, ticket as never);
      // The queue's return targets travel with the context, labelled for the desk.
      expect(accepted.body.context.returnTargets).toEqual([{ key: 'sales', label: 'sales' }]);
      const grant = accepted.body.room;
      roomName = grant.roomName;
      operator = await joinAsOperator({ serverUrl: grant.serverUrl, token: grant.token });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      // A target outside the queue's list is refused before anything happens.
      const refused = await desk.call('POST', `/v1/desk/tickets/${ticketId}/commands`, {
        kind: 'return_to_agent',
        target: 'billing',
      });
      expect(refused.status).toBe(422);
      const back = await desk.call('POST', `/v1/desk/tickets/${ticketId}/commands`, {
        kind: 'return_to_agent',
        target: 'sales',
      });
      expect(back.status).toBe(202);
      await said(env, call, TRANSFER_LINES.announcement);
      await said(env, call, HUMAN_LINES.sales);
      await vi.waitFor(() => expect(operator.disconnected).toBe(true), { timeout: 15_000 });
      await operator.disconnect();
    });
    const { events } = result;
    at(events, 'human.state', { state: 'released', code: 'returned' });
    const completed = at(events, 'human.completed', { outcome: 'returned', operator: desk.id });
    const ended = at(events, 'segment.ended', { role: 'human', ended: 'handoff' });
    const agent = at(events, 'route.segment', {
      role: 'agent',
      reason: 'transfer',
      fromIndex: 1,
      memberId: 'sales-en',
    });
    const connected = at(events, 'transfer.completed', { outcome: 'connected', toSegment: 2 });
    expect(completed < ended && ended < agent && agent < connected).toBe(true);
    expect(
      (events[ended]!.payload.usage as Record<string, number>)['ovo.human.operator_seconds'],
    ).toBeGreaterThan(0);
    expect(result.summary.human).toMatchObject({ outcome: 'returned', operator: desk.id });
    expect(result.summary.transfers).toMatchObject({ connected: 1, failed: 0 });
    expect(result.summary.segments.map((segment: { role: string }) => segment.role)).toEqual([
      'router',
      'human',
      'agent',
    ]);
    // The ticket closed as returned and the room is gone.
    const row = await env.stack.db.query<{ status: string; release_code: string }>(
      'SELECT status, release_code FROM ovo_hq_tickets WHERE id = $1',
      [ticketId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'released', release_code: 'returned' });
    await vi.waitFor(
      async () =>
        expect((await roomsOf(server).listRooms()).map((room) => room.name)).not.toContain(
          roomName,
        ),
      { timeout: 15_000, interval: 500 },
    );
  });
});
