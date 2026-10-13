import { describe, expect, it } from 'vitest';
import type { Trunk } from '../../src/config/trunks.ts';
import type { ClientHandlers } from '../../src/sip/client-transaction.ts';
import type { Flow } from '../../src/sip/flow.ts';
import { SipHeaders, type SipRequest } from '../../src/sip/message.ts';
import { OptionsPinger, type PingHost } from '../../src/sip/options-ping.ts';
import type { TransactionLayer } from '../../src/sip/transactions.ts';
import { FakeClock, settle } from '../support/fake-clock.ts';
import { recordingLogger } from '../support/harness.ts';

const FLOW: Flow = { transport: 'udp', address: '127.0.0.1', port: 5070 };
const trunk = {
  id: 'loop',
  transport: 'udp',
  optionsPingSeconds: 30,
  outbound: { proxy: 'sip:127.0.0.1:5070' },
} as unknown as Trunk;

function pinger(answer: (handlers: ClientHandlers) => void) {
  const clock = new FakeClock(0);
  const pings: SipRequest[] = [];
  const host: PingHost = {
    clock,
    logger: recordingLogger(),
    advertisedHost: '127.0.0.1',
    via: () => 'SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bKping',
    resolve: async () => FLOW,
    transactions: {
      request(request: SipRequest, _flow: Flow, handlers: ClientHandlers) {
        pings.push(request);
        answer(handlers);
      },
    } as unknown as TransactionLayer,
  };
  return { clock, pings, instance: new OptionsPinger(host, [trunk]) };
}

const ok = { kind: 'response', status: 200, reason: 'OK', headers: new SipHeaders() } as const;

describe('OPTIONS keep-alive (§4.6)', () => {
  it('pings every interval on one rescheduled timer and stops cleanly', async () => {
    const { clock, pings, instance } = pinger((h) =>
      h.onResponse({ ...ok, body: new Uint8Array() }),
    );
    instance.start();
    await clock.advanceAsync(10 * 30_000);
    expect(pings).toHaveLength(11);
    expect(pings.every((p) => p.method === 'OPTIONS')).toBe(true);
    expect(clock.pending).toBe(1);
    expect(instance.snapshot()).toEqual({ loop: 'up' });
    instance.stop();
    expect(clock.pending).toBe(0);
    await clock.advanceAsync(60_000);
    expect(pings).toHaveLength(11);
  });

  it('marks the trunk down on a transaction timeout', async () => {
    const { pings, instance } = pinger((h) => h.onTimeout());
    instance.start();
    await settle();
    expect(pings).toHaveLength(1);
    expect(instance.snapshot()).toEqual({ loop: 'down' });
    instance.stop();
  });
});
