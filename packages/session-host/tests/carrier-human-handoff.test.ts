import { describe, expect, it, vi } from 'vitest';
import type { HandoffTarget, TelephonyControl } from '@winsendotai/ovo-contracts';
import {
  AGENT_TRANSFER_QUEUE,
  CarrierHumanHandoff,
  transferCarrierLeg,
} from '../src/carrier-human-handoff.ts';

const phone: HandoffTarget = { kind: 'phone', e164: '+918041234567' };
const capabilities = (handoff: HandoffTarget['kind'][] = ['phone', 'queue']) => ({
  carrierId: 'twilio',
  control: { handoff } as never,
});

function control(result: Awaited<ReturnType<TelephonyControl['handoff']>>) {
  return { handoff: vi.fn(async () => result) };
}

const request = {
  workspaceId: 'w-1',
  sessionId: 's-1',
  idempotencyKey: 'transfer:s-1',
  queueId: 'sales',
  mode: 'AUTO_ASSIGN' as const,
  summary: '',
  context: {},
  acceptTimeoutMs: 30_000,
};

describe('HumanHandoffPort over the carrier (AGT-15)', () => {
  it('hands the call to the queue target and reports the carrier receipt', async () => {
    const carrier = control({ kind: 'confirmed', receiptId: 'twilio:CA1:transfer:s-1' });
    const port = new CarrierHumanHandoff({
      control: carrier,
      capabilities: capabilities(),
      carrierCallId: 'CA1',
      targets: { sales: phone },
    });
    expect(await port.request(request)).toEqual({
      id: 'twilio:transfer:s-1',
      workspaceId: 'w-1',
      sessionId: 's-1',
      queueId: 'sales',
      status: 'accepted',
      version: 1,
      assignedOperatorId: 'carrier:twilio:CA1:transfer:s-1',
    });
    expect(carrier.handoff).toHaveBeenCalledWith('CA1', phone, 'transfer:s-1');
  });

  it('moves the call once however often the same request is retried', async () => {
    const carrier = control({ kind: 'confirmed', receiptId: 'r' });
    const port = new CarrierHumanHandoff({
      control: carrier,
      capabilities: capabilities(),
      carrierCallId: 'CA1',
      targets: { sales: phone },
    });
    const [first, second] = await Promise.all([port.request(request), port.request(request)]);
    expect(second).toEqual(first);
    expect(carrier.handoff).toHaveBeenCalledTimes(1);
  });

  it('releases a request for an unknown queue or a target kind the carrier cannot reach', async () => {
    const carrier = control({ kind: 'confirmed', receiptId: 'r' });
    const unknown = new CarrierHumanHandoff({
      control: carrier,
      capabilities: capabilities(),
      carrierCallId: 'CA1',
      targets: {},
    });
    expect((await unknown.request(request)).status).toBe('released');
    const unsupported = new CarrierHumanHandoff({
      control: carrier,
      capabilities: capabilities([]),
      carrierCallId: 'CA1',
      targets: { sales: phone },
    });
    expect((await unsupported.request(request)).status).toBe('released');
    expect(carrier.handoff).not.toHaveBeenCalled();
  });

  it('keeps an unknown carrier outcome as offered, and a refusal as released', async () => {
    const offered = new CarrierHumanHandoff({
      control: control({ kind: 'unknown', reason: 'timeout' }),
      capabilities: capabilities(),
      carrierCallId: 'CA1',
      targets: { sales: phone },
    });
    expect((await offered.request(request)).status).toBe('offered');
    const refused = new CarrierHumanHandoff({
      control: control({ kind: 'rejected', retryable: false, reason: 'Twilio HTTP 400' }),
      capabilities: capabilities(),
      carrierCallId: 'CA1',
      targets: { sales: phone },
    });
    expect((await refused.request(request)).status).toBe('released');
  });

  it('has no operator presence and no claim to accept or release', async () => {
    const port = new CarrierHumanHandoff({
      control: control({ kind: 'confirmed', receiptId: 'r' }),
      capabilities: capabilities(),
      carrierCallId: 'CA1',
      targets: {},
    });
    expect(await port.presence()).toEqual([]);
    expect(await port.accept()).toEqual({ kind: 'conflict' });
    expect(await port.release()).toEqual({ kind: 'conflict' });
  });
});

describe('transferCarrierLeg', () => {
  const leg = (carrier: Pick<TelephonyControl, 'handoff'>) =>
    transferCarrierLeg({
      control: carrier,
      capabilities: capabilities(),
      carrierCallId: 'CA1',
      target: { kind: 'queue', name: 'collections' },
      workspaceId: 'w-1',
      sessionId: 's-1',
    });

  it('requests the agent transfer queue, keyed by the session', async () => {
    const carrier = control({ kind: 'confirmed', receiptId: 'r' });
    expect(await leg(carrier)).toBe(true);
    expect(carrier.handoff).toHaveBeenCalledWith(
      'CA1',
      { kind: 'queue', name: 'collections' },
      'transfer:s-1',
    );
    expect(AGENT_TRANSFER_QUEUE).toBe('agent-transfer');
  });

  it('reports a refused transfer so the caller can hang up instead', async () => {
    expect(await leg(control({ kind: 'rejected', retryable: true, reason: '429' }))).toBe(false);
    expect(await leg(control({ kind: 'unknown', reason: 'socket' }))).toBe(true);
  });
});
