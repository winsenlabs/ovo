import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import type { CarrierHttpRoute } from '@winsendotai/ovo-contracts';
import { twilioIngress, twilioSignature } from '../src/index.ts';
import wire from './fixtures/stream-status.json' with { type: 'json' };

const sid = 'AC00000000000000000000000000000000';
const callSid = 'CA00000000000000000000000000000000';
const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  workspaceId: 'w1',
  config: { accountSid: sid },
  secret: 'fixture-auth-token',
};

let lines: Record<string, unknown>[] = [];
beforeEach(() => {
  lines = [];
  for (const stream of ['log', 'error'] as const)
    vi.spyOn(console, stream).mockImplementation((line: string) => {
      lines.push(JSON.parse(line));
    });
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  return createFakeCarrierHostPorts({ bindings: { b1: binding } });
}

function request(
  host: ReturnType<typeof setup>,
  purpose: CarrierHttpRoute['purpose'],
  fields: Record<string, string>,
  signature?: string,
) {
  const url = host.callbackUrl(
    'twilio',
    'b1',
    purpose,
    purpose === 'inbound' ? undefined : { requestId: callSid },
  );
  return {
    method: 'POST' as const,
    externalUrl: url,
    bindingId: 'b1',
    query: Object.fromEntries(new URL(url).searchParams),
    rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
    headers: { 'x-twilio-signature': signature ?? twilioSignature(binding.secret, url, fields) },
  };
}

const route = (purpose: CarrierHttpRoute['purpose']) =>
  twilioIngress.routes.find((item) => item.purpose === purpose)!;

describe('Twilio status callbacks (OBS-11)', () => {
  it('keys a callback without SequenceNumber by call and status, at the Twilio timestamp', async () => {
    const host = setup();
    const fields = wire.callStatusWithoutSequence;
    const reply = await route('status').handle(request(host, 'status', fields), host);
    expect(reply.status).toBe(204);
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({
      eventId: `${callSid}:status:completed`,
      state: 'completed',
      occurredAt: new Date('2026-10-06T10:00:05Z'),
      payload: { sequenceNumber: null, callbackSource: 'call-progress-events' },
    });
    expect(lines.find((line) => line.event === 'twilio_status_unsequenced')).toMatchObject({
      carrierCallId: callSid,
      callStatus: 'completed',
    });
  });

  it('keeps sequence keys and carrier times so out-of-order delivery can be ordered', async () => {
    const host = setup();
    const completed = {
      CallSid: callSid,
      CallStatus: 'completed',
      SequenceNumber: '3',
      Timestamp: 'Tue, 06 Oct 2026 10:00:09 +0000',
    };
    const ringing = { ...completed, CallStatus: 'ringing', SequenceNumber: '1' };
    ringing.Timestamp = 'Tue, 06 Oct 2026 10:00:01 +0000';
    for (const fields of [completed, ringing, completed])
      expect((await route('status').handle(request(host, 'status', fields), host)).status).toBe(
        204,
      );
    expect(host.events.map((event) => [event.eventId, event.occurredAt.toISOString()])).toEqual([
      [`${callSid}:status:3`, '2026-10-06T10:00:09.000Z'],
      [`${callSid}:status:1`, '2026-10-06T10:00:01.000Z'],
      [`${callSid}:status:3`, '2026-10-06T10:00:09.000Z'],
    ]);
  });

  it('falls back to the receive time for an unreadable timestamp', async () => {
    const host = setup();
    const fields = { CallSid: callSid, CallStatus: 'busy', Timestamp: 'not a date' };
    const before = Date.now();
    await route('status').handle(request(host, 'status', fields), host);
    expect(host.events[0]!.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('logs and refuses a forged status callback', async () => {
    const host = setup();
    const fields = { CallSid: callSid, CallStatus: 'completed' };
    const reply = await route('status').handle(request(host, 'status', fields, 'forged'), host);
    expect(reply.status).toBe(403);
    expect(host.events).toHaveLength(0);
    expect(lines.find((line) => line.event === 'twilio_callback_unauthenticated')).toMatchObject({
      purpose: 'status',
      check: 'signature',
      carrierCallId: callSid,
    });
  });
});

describe('Twilio stream status callbacks (OBS-11)', () => {
  it('asks Twilio for stream status on the inbound connect', async () => {
    const host = setup();
    const fields = {
      CallSid: callSid,
      AccountSid: sid,
      From: '+15550123',
      To: '+15550456',
      Direction: 'inbound',
    };
    const reply = await route('inbound').handle(request(host, 'inbound', fields), host);
    const status = /<Stream url="[^"]+" statusCallback="([^"]+)" statusCallbackMethod="POST">/.exec(
      reply.body,
    )?.[1];
    expect(status).toBeDefined();
    const url = new URL(status!.replaceAll('&amp;', '&'));
    expect(url.pathname).toBe('/carriers/twilio/b1/stream-status');
    expect(url.searchParams.get('r')).toBe(callSid);
    expect(url.searchParams.get('t')).toBe(
      host.urlSecret('twilio', 'b1', 'stream-status', callSid),
    );
  });

  it('logs a signed stream error without changing call state', async () => {
    const host = setup();
    const reply = await route('stream-status').handle(
      request(host, 'stream-status', wire.streamStatus),
      host,
    );
    expect(reply.status).toBe(204);
    expect(host.events).toHaveLength(0);
    expect(lines.find((line) => line.event === 'twilio_stream_status')).toMatchObject({
      level: 'warn',
      carrierCallId: callSid,
      streamEvent: 'stream-error',
      streamError: wire.streamStatus.StreamError,
    });
  });

  it('refuses an unknown stream event and a forged stream callback', async () => {
    const host = setup();
    const unknown = { ...wire.streamStatus, StreamEvent: 'stream-paused' };
    expect(
      (await route('stream-status').handle(request(host, 'stream-status', unknown), host)).status,
    ).toBe(400);
    expect(
      (
        await route('stream-status').handle(
          request(host, 'stream-status', wire.streamStatus, 'forged'),
          host,
        )
      ).status,
    ).toBe(403);
  });
});
