import { randomUUID } from 'node:crypto';
import {
  TicketContext,
  type HumanHandoffAccept,
  type HumanHandoffRelease,
  type TicketOutcome,
  type TicketReleaseCode,
} from '@winsendotai/ovo-contracts';
import { offerTicket } from './assign.ts';
import { effectiveStatus, mayServe, rulesOf } from './rules.ts';
import { ACTIVE, isActive, presentTicket, roomNameFor, type TicketRow } from './rows.ts';
import type { NewTicket, Ticket } from './service.ts';
import { HqConflictError, type HqTx, type HqStore } from './store.ts';
import { type EngineContext, finishTicket, record } from './transitions.ts';

const CONFLICT = { kind: 'conflict' } as const;

/** Ticket lifecycle (design 5.1): create, accept, decline, release, re-offer. Every method is one atomic unit of the store. */
export class TicketLifecycle {
  constructor(
    private readonly store: HqStore,
    private readonly ctx: EngineContext,
  ) {}

  private view(row: TicketRow): Ticket {
    return presentTicket(row, this.ctx.organizationId);
  }

  async create(input: NewTicket): Promise<Ticket | 'queue_full'> {
    try {
      return await this.store.run((tx) => this.createIn(tx, input));
    } catch (error) {
      // Another unit made the same ticket, or took the call's slot, between our read and write.
      if (!(error instanceof HqConflictError)) throw error;
      return this.store.run((tx) => this.createIn(tx, input));
    }
  }

  private async createIn(tx: HqTx, input: NewTicket): Promise<Ticket | 'queue_full'> {
    const now = this.ctx.now();
    const [existing] = await tx.scan({ idempotencyKey: input.idempotencyKey, limit: 1 });
    if (existing) return { ...this.view(existing), duplicate: true };
    const { queue } = input;
    const open = await tx.scan({
      queueId: queue.id,
      statuses: ['waiting', 'offered'],
      limit: queue.maxWaiting,
    });
    if (open.length >= queue.maxWaiting) return 'queue_full';
    for (const other of await tx.scan({ callId: input.callId, statuses: ACTIVE }))
      await finishTicket(tx, (await tx.ticket(other.id, true)) ?? other, now, {
        status: 'released',
        code: 'queue_changed',
        by: 'worker',
      });
    const context = TicketContext.parse(input.context);
    const row = await tx.insertTicket({
      id: randomUUID(),
      callId: input.callId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      idempotencyKey: input.idempotencyKey,
      ...(input.routingReleaseId ? { routingReleaseId: input.routingReleaseId } : {}),
      queueId: queue.id,
      queueKey: queue.key,
      queueName: queue.name,
      kind: queue.kind,
      mode: queue.mode,
      teamIds: [...queue.teamIds],
      languageMode: queue.language,
      offerSeconds: input.offerSeconds ?? 20,
      status: 'waiting',
      version: 1,
      priority: input.priority,
      ...(input.language ? { language: input.language } : {}),
      ...(input.callerMasked ? { callerMasked: input.callerMasked } : {}),
      declinedBy: [],
      expiresAt: new Date(input.expiresAt),
      workerHeartbeatAt: now,
      commandSeq: 0,
      commandAck: 0,
      routerAgentId: input.routerAgentId,
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.callbackUntil ? { callbackUntil: new Date(input.callbackUntil) } : {}),
      context,
      contextRetentionHours: input.contextRetentionHours,
      createdAt: now,
      updatedAt: now,
    });
    await record(tx, row, now, { state: 'waiting', by: 'worker' });
    return this.view((await offerTicket(tx, this.ctx, row)) ?? row);
  }

  async get(id: string): Promise<Ticket | undefined> {
    const row = await this.store.run((tx) => tx.ticket(id));
    return row && this.view(row);
  }

  async accept(input: HumanHandoffAccept) {
    return this.store.run(async (tx) => {
      if (input.workspaceId !== this.ctx.organizationId) return CONFLICT;
      await tx.lockOperator(input.operatorId);
      const row = await tx.ticket(input.ticketId, true);
      if (!row) return CONFLICT;
      const replay = `accept:${input.idempotencyKey}`;
      if (await tx.hasEvent(row.id, replay))
        return row.assignedOperatorId === input.operatorId ? this.view(row) : CONFLICT;
      if (row.kind !== 'managed') return CONFLICT;
      if (
        (row.status !== 'waiting' && row.status !== 'offered') ||
        row.version !== input.expectedVersion
      )
        return CONFLICT;
      const now = this.ctx.now();
      const operator = await tx.operator(input.operatorId);
      if (
        !operator ||
        effectiveStatus(operator, now, this.ctx.presenceTtlSeconds) === 'OFFLINE' ||
        !mayServe(operator, rulesOf(row), row.language) ||
        row.declinedBy.includes(operator.userId) ||
        (row.status === 'offered' && row.assignedOperatorId !== operator.userId)
      )
        return { kind: 'not_eligible' as const };
      const held = await tx.scan({ assignedTo: operator.userId, statuses: ['accepted'] });
      if (held.length >= operator.capacity) return { kind: 'at_capacity' as const };
      const accepted = await tx.updateTicket(row.id, {
        status: 'accepted',
        version: row.version + 1,
        assignedOperatorId: operator.userId,
        offerExpiresAt: null,
        acceptedAt: now,
        roomName: roomNameFor(row.id),
      });
      await tx.putOperator({ ...operator, lastAssignedAt: now });
      await record(tx, accepted, now, {
        state: 'accepted',
        by: 'operator',
        operator: operator.userId,
        source: replay,
      });
      return this.view(accepted);
    });
  }

  async decline(input: { ticketId: string; operatorId: string; expectedVersion: number }) {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(input.ticketId, true);
      const operator = await tx.operator(input.operatorId);
      if (!row || !operator || row.kind !== 'managed') return CONFLICT;
      if (
        (row.status !== 'waiting' && row.status !== 'offered') ||
        row.version !== input.expectedVersion
      )
        return CONFLICT;
      if (!mayServe(operator, rulesOf(row), row.language)) return CONFLICT;
      if (row.status === 'offered' && row.assignedOperatorId !== operator.userId) return CONFLICT;
      const now = this.ctx.now();
      const declined = await tx.updateTicket(row.id, {
        status: 'waiting',
        version: row.version + 1,
        assignedOperatorId: null,
        offerExpiresAt: null,
        declinedBy: [...new Set([...row.declinedBy, operator.userId])],
      });
      await record(tx, declined, now, {
        state: 'waiting',
        by: 'operator',
        operator: operator.userId,
        code: 'declined',
      });
      return this.view((await offerTicket(tx, this.ctx, declined)) ?? declined);
    });
  }

  async release(
    input: HumanHandoffRelease & {
      code: TicketReleaseCode;
      by: 'worker' | 'operator' | 'sweeper' | 'admin' | 'callback';
      outcome?: TicketOutcome;
    },
  ) {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(input.ticketId, true);
      if (!row || input.workspaceId !== this.ctx.organizationId) return CONFLICT;
      if (!isActive(row)) return this.view(row);
      if (row.version !== input.expectedVersion) return CONFLICT;
      return this.view(
        await finishTicket(tx, row, this.ctx.now(), {
          status: 'released',
          code: input.code,
          by: input.by,
          ...(input.outcome ? { outcome: input.outcome } : {}),
        }),
      );
    });
  }

  async reoffer(id: string, expectedVersion: number, code: 'operator_no_show') {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (!row || row.status !== 'accepted' || row.version !== expectedVersion) return CONFLICT;
      const now = this.ctx.now();
      const waiting = await tx.updateTicket(id, {
        status: 'waiting',
        version: row.version + 1,
        assignedOperatorId: null,
        acceptedAt: null,
        roomName: null,
        declinedBy: [
          ...new Set([
            ...row.declinedBy,
            ...(row.assignedOperatorId ? [row.assignedOperatorId] : []),
          ]),
        ],
        command: null,
      });
      await record(tx, waiting, now, {
        state: 'waiting',
        by: 'worker',
        code,
        ...(row.assignedOperatorId ? { operator: row.assignedOperatorId } : {}),
      });
      return this.view((await offerTicket(tx, this.ctx, waiting)) ?? waiting);
    });
  }

  async markHandedOff(id: string): Promise<void> {
    await this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (!row || !isActive(row)) return;
      await finishTicket(tx, row, this.ctx.now(), {
        status: 'released',
        code: 'handed_off',
        by: 'worker',
        outcome: 'handed_off',
        connect: true,
      });
    });
  }
}
