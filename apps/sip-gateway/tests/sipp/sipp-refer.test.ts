import { afterEach, describe, expect, it } from 'vitest';
import { loopbackTrunk, startHarness, type Harness } from '../support/harness.ts';
import { SIPP, evidence, runSipp, tracedMessages, type SippOptions } from '../support/sipp.ts';

// R3 scenarios with SIPp as the trunk's far end: it sends the INVITE, then answers the gateway's
// REFER and plays the NOTIFYs. Gateway on 127.0.0.1:15360.
const SIP_PORT = 15360;
const UAC: SippOptions = { localPort: 15361, mediaPort: 16300, remote: `127.0.0.1:${SIP_PORT}` };
const ENV = {
  OVO_SIP_PORT: String(SIP_PORT),
  OVO_SIP_RTP_PORT_MIN: '41400',
  OVO_SIP_RTP_PORT_MAX: '41499',
  OVO_SIP_REFER_TIMEOUT_MS: '2000',
};
const REFER = {
  enabled: true,
  phoneUriTemplate: 'sip:{e164}@sbc.example.net;user=phone',
  allowedHosts: ['.acd.example.net'],
};
const SIP_TARGET = {
  kind: 'sip',
  uri: 'sips:desk@queue.acd.example.net',
  headers: { 'X-OVO-Ticket': 't-1', 'X-OVO-Language': 'en IN' },
} as const;

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function gateway(refer: Record<string, unknown> = REFER): Promise<Harness> {
  harness = await startHarness({
    env: ENV,
    media: evidence(),
    trunks: [loopbackTrunk({ refer })],
  });
  return harness;
}

async function expectPass(run: ReturnType<typeof runSipp>) {
  const result = await run.done;
  if (result.code !== 0)
    throw new Error(`sipp exit ${result.code}\n${result.errors}\n${result.output}`);
  return result;
}

/** Starts the scenario, waits for the call to be up, and returns its Call-ID. */
async function connected(h: Harness, scenario: string, keys: Record<string, string> = {}) {
  const run = runSipp(scenario, { ...UAC, keys });
  await h.media.waitFor(() => h.media.framesIn('start')[0], 10_000);
  const callId = h.running.gateway.registry.all()[0]!.callId;
  const handoff = (target: unknown, requestId = 'h-1') =>
    h.control('POST', '/v1/calls/handoff', { carrierCallId: callId, requestId, target });
  return { run, callId, handoff };
}

describe.skipIf(!SIPP)('SIPp REFER scenarios (sipp as the trunk)', { timeout: 120_000 }, () => {
  it('R3-1 uac-refer-accepted: REFER with encoded X-OVO headers, 202, NOTIFY 100 then 200, BYE', async () => {
    const h = await gateway();
    const { run, handoff } = await connected(h, 'uac-refer-accepted');
    const reply = await handoff(SIP_TARGET);
    expect(reply).toMatchObject({ status: 200, body: { kind: 'confirmed' } });
    const result = await expectPass(run);
    const refer = tracedMessages(result.messages, /^REFER /)[0]!;
    expect(refer).toContain(
      'Refer-To: <sips:desk@queue.acd.example.net?X-OVO-Ticket=t-1&X-OVO-Language=en%20IN>',
    );
    expect(refer).toContain('Referred-By: <sip:ovo@127.0.0.1>');
    expect(refer).toMatch(/^Contact: <sip:/m);
    expect(tracedMessages(result.messages, /^BYE /)).toHaveLength(1);
    await h.media.waitFor(() => h.media.framesIn('stop')[0]);
    expect(h.media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'transferred' });
    const completed = await h.media.waitFor(() =>
      h.media.statuses.find((s) => s.state === 'completed'),
    );
    expect(completed.payload).toMatchObject({ endReason: 'transferred' });
    expect(h.running.gateway.registry.size).toBe(0);
  });

  it('R3-2 uac-refer-accepted: a phone target uses the trunk template', async () => {
    const h = await gateway();
    const { run, handoff } = await connected(h, 'uac-refer-accepted');
    expect((await handoff({ kind: 'phone', e164: '+919000000042' })).body.kind).toBe('confirmed');
    const result = await expectPass(run);
    expect(tracedMessages(result.messages, /^REFER /)[0]).toContain(
      'Refer-To: <sip:+919000000042@sbc.example.net;user=phone>',
    );
  });

  it('R3-3 uac-refer-notify-503: rejected and retryable, the caller stays until hangup', async () => {
    const h = await gateway();
    const { run, callId, handoff } = await connected(h, 'uac-refer-notify-503');
    expect((await handoff(SIP_TARGET)).body).toEqual({
      kind: 'rejected',
      reason: 'refer_failed_503',
      retryable: true,
    });
    expect(h.running.gateway.registry.size).toBe(1);
    expect(h.media.framesIn('stop')).toHaveLength(0);
    await h.control('POST', '/v1/calls/hangup', { carrierCallId: callId });
    await expectPass(run);
  });

  it.each([
    [403, false],
    [503, true],
  ])('R3-4 a %i to the REFER rejects (retryable %s)', async (status, retryable) => {
    const h = await gateway();
    const { run, callId, handoff } = await connected(h, `uac-refer-${status}`);
    expect((await handoff(SIP_TARGET)).body).toEqual({
      kind: 'rejected',
      reason: `refer_declined_${status}`,
      retryable,
    });
    await h.control('POST', '/v1/calls/hangup', { carrierCallId: callId });
    await expectPass(run);
  });

  it('R3-5 uac-refer-silent: 202 and no NOTIFY is unknown refer_no_notify, then the gateway hangs up', async () => {
    const h = await gateway();
    const { run, handoff } = await connected(h, 'uac-refer-silent');
    expect((await handoff(SIP_TARGET)).body).toEqual({
      kind: 'unknown',
      reason: 'refer_no_notify',
    });
    await expectPass(run);
    await h.media.waitFor(() => h.running.gateway.registry.size === 0, 10_000);
  });

  it('R3-6 uac-refer-never: a trunk with refer disabled sends no REFER', async () => {
    const h = await gateway({ enabled: false });
    const { run, callId, handoff } = await connected(h, 'uac-refer-never');
    expect((await handoff(SIP_TARGET)).body).toEqual({
      kind: 'rejected',
      reason: 'refer_not_enabled',
      retryable: false,
    });
    await h.control('POST', '/v1/calls/hangup', { carrierCallId: callId });
    const result = await expectPass(run);
    expect(tracedMessages(result.messages, /^REFER /)).toHaveLength(0);
  });
});
