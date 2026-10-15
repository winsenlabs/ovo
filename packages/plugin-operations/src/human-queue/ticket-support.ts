import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type DeskCommand, type WebhookDestination, type WrapUp } from '@winsendotai/ovo-contracts';
import { isActive, sha256 } from './rows.ts';
import type { TicketEventInput } from './service.ts';
import { type HqStore } from './store.ts';
import { type EngineContext, record } from './transitions.ts';

const EVENT_BYTES = 4_096;

/** Worker liveness, operator commands, third-party destinations, events and context access. */
export class TicketSupport {
  constructor(
    private readonly store: HqStore,
    private readonly ctx: EngineContext,
  ) {}

  async workerBeat(id: string): Promise<void> {
    await this.store.run(async (tx) => {
      const row = await tx.ticket(id);
      if (row && isActive(row)) await tx.touchTicket(id, { workerHeartbeatAt: this.ctx.now() });
    });
  }

  async markConnected(id: string): Promise<void> {
    await this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (row?.status === 'accepted' && !row.connectedAt)
        await tx.updateTicket(id, { connectedAt: this.ctx.now() });
    });
  }

  async setCommand(id: string, operatorId: string, command: DeskCommand) {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (!row || row.status !== 'accepted') return 'conflict' as const;
      if (row.assignedOperatorId !== operatorId) return 'forbidden' as const;
      await tx.updateTicket(id, { command, commandSeq: row.commandSeq + 1 });
      return row.commandSeq + 1;
    });
  }

  async ackCommand(id: string, seq: number): Promise<void> {
    await this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (row && seq > row.commandAck)
        await tx.touchTicket(id, { commandAck: Math.min(seq, row.commandSeq) });
    });
  }

  async setDestination(
    id: string,
    source: 'sync' | 'callback',
    destination: WebhookDestination,
    externalRef?: string,
  ): Promise<boolean> {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (!row || row.kind !== 'external' || row.destination) return false;
      if (row.status !== 'waiting' && row.status !== 'offered') return false;
      const now = this.ctx.now();
      const updated = await tx.updateTicket(id, {
        destination,
        version: row.version + 1,
        ...(externalRef ? { externalRef } : {}),
      });
      await record(tx, updated, now, {
        state: 'destination',
        by: source === 'sync' ? 'worker' : 'callback',
      });
      return true;
    });
  }

  async setWrapUp(id: string, operatorId: string, wrap: WrapUp): Promise<boolean> {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (!row || row.assignedOperatorId !== operatorId || !row.context) return false;
      if (row.status !== 'accepted' && row.status !== 'released') return false;
      await tx.updateTicket(id, { wrapUp: wrap });
      return true;
    });
  }

  async appendEvent(id: string, event: TicketEventInput) {
    if (new TextEncoder().encode(JSON.stringify(event.payload)).byteLength >= EVENT_BYTES)
      throw new RangeError(`A ticket event payload is under ${EVENT_BYTES} bytes`);
    return this.store.run(async (tx) => {
      if (!(await tx.ticket(id))) throw new Error('Unknown human queue ticket');
      return tx.addEvent(id, event, this.ctx.now());
    });
  }

  async context(id: string, who: { operatorId: string } | { token: string }) {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(id);
      if (!row) return undefined;
      const now = this.ctx.now();
      if ('operatorId' in who) {
        if (row.assignedOperatorId !== who.operatorId) return 'forbidden' as const;
      } else {
        if (!row.contextTokenHash) return 'forbidden' as const;
        const given = Buffer.from(sha256(who.token), 'hex');
        const stored = Buffer.from(row.contextTokenHash, 'hex');
        if (given.length !== stored.length || !timingSafeEqual(given, stored))
          return 'forbidden' as const;
        if (!row.contextTokenExpiresAt || row.contextTokenExpiresAt <= now)
          return 'expired' as const;
      }
      return row.context ?? ('expired' as const);
    });
  }

  async issueContextToken(id: string, ttlSeconds: number): Promise<string> {
    return this.store.run(async (tx) => {
      const row = await tx.ticket(id, true);
      if (!row?.context) throw new Error('Unknown or scrubbed human queue ticket');
      const token = randomBytes(32).toString('base64url');
      await tx.updateTicket(id, {
        contextTokenHash: sha256(token),
        contextTokenExpiresAt: new Date(this.ctx.now().getTime() + ttlSeconds * 1_000),
      });
      return token;
    });
  }
}
