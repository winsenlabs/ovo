import { afterEach, describe, expect, it } from 'vitest';
import { FROM, loopbackTrunk, startHarness, type Harness } from '../support/harness.ts';
import { SIPP, evidence, runSipp, tracedMessages, type SippOptions } from '../support/sipp.ts';

// Stretch S1 with SIPp at both ends: the trunk's caller (UAC) and the destination behind the
// trunk's outbound proxy (UAS). Gateway on 127.0.0.1:15460.
const SIP_PORT = 15460;
const UAC: SippOptions = { localPort: 15461, mediaPort: 16400, remote: `127.0.0.1:${SIP_PORT}` };
const UAS: SippOptions = { localPort: 15462, mediaPort: 16410, pauseMs: 2000 };
const ENV = {
  OVO_SIP_PORT: String(SIP_PORT),
  OVO_SIP_RTP_PORT_MIN: '41500',
  OVO_SIP_RTP_PORT_MAX: '41599',
  OVO_SIP_BRIDGE_ENABLED: 'true',
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function expectPass(run: ReturnType<typeof runSipp>) {
  const result = await run.done;
  if (result.code !== 0)
    throw new Error(`sipp exit ${result.code}\n${result.errors}\n${result.output}`);
  return result;
}

describe.skipIf(!SIPP)('SIPp bridge scenario (sipp at both ends)', { timeout: 120_000 }, () => {
  it('R3-S1 bridges the caller to a destination, then a hang-up at the destination ends both legs', async () => {
    harness = await startHarness({
      env: ENV,
      media: evidence(),
      trunks: [
        loopbackTrunk({
          refer: { enabled: true, mode: 'bridge' },
          outbound: {
            enabled: true,
            proxy: `sip:127.0.0.1:${UAS.localPort}`,
            fromNumbers: [FROM],
            auth: 'ip',
          },
        }),
      ],
    });
    const h = harness;
    const destination = runSipp('uas-answer', UAS);
    const caller = runSipp('uac-bridge', UAC);
    await h.media.waitFor(() => h.media.framesIn('start')[0], 10_000);
    const callId = h.running.gateway.registry.all()[0]!.callId;
    const reply = await h.control('POST', '/v1/calls/handoff', {
      carrierCallId: callId,
      requestId: 'bridge-1',
      target: { kind: 'phone', e164: '+919000000042' },
    });
    expect(reply.body.kind).toBe('confirmed');
    expect(h.media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'transferred' });
    const dest = await expectPass(destination);
    const far = await expectPass(caller);
    expect(tracedMessages(dest.messages, /^INVITE /)[0]).toContain(
      `INVITE sip:+919000000042@127.0.0.1:${UAS.localPort}`,
    );
    // The destination hung up first; the gateway answered it and hung up the caller.
    expect(tracedMessages(far.messages, /^BYE /)).toHaveLength(1);
    await h.media.waitFor(() => h.running.gateway.registry.size === 0, 10_000);
    expect(h.running.gateway.pool.stats().inUse).toBe(0);
  });
});
