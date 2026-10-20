import { describe, expect, it, vi } from 'vitest';
import { handoffTarget, sipContextHeaders } from '../src/human-carrier.ts';
import { carrierHandoffFor } from '../src/worker-carrier-handoff.ts';

describe('the context a SIP transfer carries (human queue design 7.8)', () => {
  it('has our ids first and never lets an answered header take an X-OVO name', () => {
    expect(
      sipContextHeaders({
        callId: 'call-1',
        ticketId: 'ticket-1',
        language: 'hi',
        intent: 'billing',
        contextUrl: 'https://ovo.example.test/api/v1/human-queue/context/ticket-1?t=abc',
        answered: { 'X-Acd-Ticket': '123', 'x-ovo-ticket': 'forged', 'X-OVO-Call-Id': 'forged' },
      }),
    ).toEqual({
      'X-Acd-Ticket': '123',
      'X-OVO-Call-Id': 'call-1',
      'X-OVO-Ticket': 'ticket-1',
      'X-OVO-Language': 'hi',
      'X-OVO-Intent': 'billing',
      'X-OVO-Context-Url': 'https://ovo.example.test/api/v1/human-queue/context/ticket-1?t=abc',
    });
  });

  it('leaves out what is absent or blank, and keeps values to short printable ASCII', () => {
    const headers = sipContextHeaders({
      callId: 'call-1',
      ticketId: 'ticket-1',
      intent: 'bill\r\ning \u0007now ' + 'x'.repeat(400),
      answered: {},
    });
    expect(Object.keys(headers)).toEqual(['X-OVO-Call-Id', 'X-OVO-Ticket', 'X-OVO-Intent']);
    expect(headers['X-OVO-Intent']).toMatch(/^billing now x+$/);
    expect(headers['X-OVO-Intent']!.length).toBeLessThanOrEqual(256);
  });

  it('gives a phone number no headers and a SIP URI its own', () => {
    expect(handoffTarget({ kind: 'phone', e164: '+914012345678' }, { 'X-A': '1' })).toEqual({
      kind: 'phone',
      e164: '+914012345678',
    });
    expect(
      handoffTarget({ kind: 'sip', uri: 'sips:a@h.example.com', headers: {} }, { 'X-A': '1' }),
    ).toEqual({
      kind: 'sip',
      uri: 'sips:a@h.example.com',
      headers: { 'X-A': '1' },
    });
  });
});

describe('moving the live carrier leg before the session ends (design 7.8)', () => {
  const job = {
    id: 'job-1',
    workspaceId: 'ws-1',
    ownerEpoch: 1,
    payload: { releaseId: 'r' },
  } as never;
  const route = { sessionId: 's-1', jobId: 'job-1' } as never;
  const sip = {
    kind: 'sip' as const,
    uri: 'sips:a@h.example.com',
    headers: { 'X-OVO-Ticket': 't' },
  };

  function handoff(
    over: {
      kinds?: string[];
      result?: unknown;
      throws?: boolean;
      callId?: string | null;
      forJob?: () => Promise<unknown>;
    } = {},
  ) {
    const control = {
      handoff: vi.fn(async () => {
        if (over.throws) throw new Error('boom');
        return over.result ?? { kind: 'confirmed', receiptId: 'r1' };
      }),
    };
    const run = carrierHandoffFor({
      carriers: {
        forJob:
          over.forJob ??
          (async () => ({
            control,
            carrier: { capabilities: { control: { handoff: over.kinds ?? ['phone', 'sip'] } } },
          })),
      } as never,
      store: {
        getSessionRoute: async () =>
          over.callId === null
            ? { carrierCallId: undefined }
            : { carrierCallId: over.callId ?? 'CA1' },
      } as never,
    });
    return { run, control };
  }

  it('asks the job carrier under the idempotent request id human:<ticket>', async () => {
    const { run, control } = handoff();
    expect(await run(job, route, sip, 'ticket-9')).toEqual({ kind: 'confirmed' });
    expect(control.handoff).toHaveBeenCalledWith('CA1', sip, 'human:ticket-9');
  });

  it('treats an unknown outcome as handed on, and a throwing control call too', async () => {
    expect(
      await handoff({ result: { kind: 'unknown', reason: 'refer_no_notify' } }).run(
        job,
        route,
        sip,
        't',
      ),
    ).toEqual({
      kind: 'unknown',
    });
    expect(await handoff({ throws: true }).run(job, route, sip, 't')).toEqual({ kind: 'unknown' });
  });

  it('refuses what the carrier cannot do, without asking it', async () => {
    const { run, control } = handoff({ kinds: ['phone'] });
    expect(await run(job, route, sip, 't')).toEqual({
      kind: 'rejected',
      reason: 'unsupported_kind',
    });
    expect(control.handoff).not.toHaveBeenCalled();
    expect(await handoff({ callId: null }).run(job, route, sip, 't')).toEqual({
      kind: 'rejected',
      reason: 'no_carrier_call',
    });
    expect(
      await handoff({ forJob: async () => Promise.reject(new Error('no carrier')) }).run(
        job,
        route,
        sip,
        't',
      ),
    ).toEqual({ kind: 'rejected', reason: 'carrier_unavailable' });
  });

  it('records a carrier refusal as a short code, never carrier text', async () => {
    const { run } = handoff({
      result: { kind: 'rejected', retryable: false, reason: 'REFER not enabled (403 Forbidden)' },
    });
    const answer = await run(job, route, sip, 't');
    expect(answer).toMatchObject({ kind: 'rejected' });
    expect((answer as { reason: string }).reason).toMatch(/^[a-z0-9_]{1,40}$/);
  });
});
