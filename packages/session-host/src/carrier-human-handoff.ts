import {
  HumanHandoffRequest,
  type CarrierCapabilities,
  type HandoffTarget,
  type HumanHandoffPort,
  type HumanHandoffTicket,
  type HumanPresence,
  type TelephonyControl,
} from '@winsendotai/ovo-contracts';

/**
 * `HumanHandoffPort` carried out by the call's own carrier (AGT-15): a request hands the live leg
 * to the queue's target through `TelephonyControl.handoff` (a REST carrier updates the live call
 * to dial the number or join the queue). The carrier owns the assignment from then on, so there is no operator
 * presence to report and no claim to accept or release here.
 *
 * One port serves one call. Requests are idempotent by key: a retry returns the first attempt's
 * ticket and never moves the call twice.
 */
export class CarrierHumanHandoff implements HumanHandoffPort {
  private readonly tickets = new Map<string, Promise<HumanHandoffTicket>>();

  constructor(
    private readonly input: {
      control: Pick<TelephonyControl, 'handoff'>;
      capabilities: Pick<CarrierCapabilities, 'carrierId' | 'control'>;
      carrierCallId: string;
      /** Where each queue id hands the call. */
      targets: Readonly<Record<string, HandoffTarget>>;
    },
  ) {}

  request(raw: HumanHandoffRequest): Promise<HumanHandoffTicket> {
    const request = HumanHandoffRequest.parse(raw);
    const existing = this.tickets.get(request.idempotencyKey);
    if (existing) return existing;
    const ticket = this.handOff(request);
    this.tickets.set(request.idempotencyKey, ticket);
    return ticket;
  }

  async presence(): Promise<readonly HumanPresence[]> {
    return [];
  }

  async accept(): Promise<{ kind: 'conflict' }> {
    return { kind: 'conflict' };
  }

  async release(): Promise<{ kind: 'conflict' }> {
    return { kind: 'conflict' };
  }

  private async handOff(request: HumanHandoffRequest): Promise<HumanHandoffTicket> {
    const ticket = (status: HumanHandoffTicket['status'], operator?: string) => ({
      id: `${this.input.capabilities.carrierId}:${request.idempotencyKey}`,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      queueId: request.queueId,
      status,
      version: 1,
      ...(operator ? { assignedOperatorId: operator } : {}),
    });
    const target = Object.hasOwn(this.input.targets, request.queueId)
      ? this.input.targets[request.queueId]
      : undefined;
    if (!target || !this.input.capabilities.control.handoff.includes(target.kind))
      return ticket('released');
    const result = await this.input.control.handoff(
      this.input.carrierCallId,
      target,
      request.idempotencyKey,
    );
    if (result.kind === 'confirmed') return ticket('accepted', `carrier:${result.receiptId}`);
    // An unknown outcome may still have moved the call; it is offered, never assumed failed.
    return ticket(result.kind === 'unknown' ? 'offered' : 'released');
  }
}

/** The queue id an agent's configured transfer target is requested under. */
export const AGENT_TRANSFER_QUEUE = 'agent-transfer';

/**
 * Hands a call the agent ended `transferred` to its target, in place of the hang-up. True once the
 * carrier has (or may have) taken the leg; false means it was refused or is unsupported, and the
 * caller hangs up as for any other ending, so a failed transfer never leaves a call open.
 */
export async function transferCarrierLeg(input: {
  control: Pick<TelephonyControl, 'handoff'>;
  capabilities: Pick<CarrierCapabilities, 'carrierId' | 'control'>;
  carrierCallId: string;
  target: HandoffTarget;
  workspaceId: string;
  sessionId: string;
}): Promise<boolean> {
  const port = new CarrierHumanHandoff({
    control: input.control,
    capabilities: input.capabilities,
    carrierCallId: input.carrierCallId,
    targets: { [AGENT_TRANSFER_QUEUE]: input.target },
  });
  const ticket = await port.request({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    idempotencyKey: `transfer:${input.sessionId}`,
    queueId: AGENT_TRANSFER_QUEUE,
    mode: 'AUTO_ASSIGN',
    summary: '',
    context: {},
    acceptTimeoutMs: 30_000,
  });
  return ticket.status === 'accepted' || ticket.status === 'offered';
}
