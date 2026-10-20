import type {
  HumanPresence,
  HumanQueue,
  HumanQueueDefinition,
  OperatorProfile,
  OperatorStatus,
} from '@winsendotai/ovo-contracts';
import { ACTIVITY_WINDOW_MS, queueActivity } from './activity.ts';
import { loads } from './assign.ts';
import { effectiveStatus, mayServe } from './rules.ts';
import type { QueueRecord } from './rows.ts';
import type { HumanQueueService, ManagedQueueRef, OperatorRow, QueueStats } from './service.ts';
import type { HqStore } from './store.ts';
import type { EngineContext } from './transitions.ts';

const DAY_MS = 24 * 3_600_000;

export function presentQueue(
  record: QueueRecord,
  workspaceId: string,
): HumanQueue & { deletedAt?: string } {
  return {
    id: record.id,
    workspaceId,
    definition: record.definition,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(record.deletedAt ? { deletedAt: record.deletedAt.toISOString() } : {}),
  };
}

/** Queue administration and operator presence. */
export class QueueAndOperatorEngine {
  constructor(
    private readonly store: HqStore,
    private readonly ctx: EngineContext,
  ) {}

  readonly queues: HumanQueueService['queues'] = {
    list: async (limit, cursor) =>
      (await this.store.queues.list(limit, cursor)).map((q) =>
        presentQueue(q, this.ctx.organizationId),
      ),
    get: async (id, options) => {
      const found = await this.store.queues.get(id);
      return found && (!found.deletedAt || options?.includeDeleted)
        ? presentQueue(found, this.ctx.organizationId)
        : undefined;
    },
    create: async (definition: HumanQueueDefinition) =>
      presentQueue(
        await this.store.queues.insert(definition, this.ctx.now()),
        this.ctx.organizationId,
      ),
    update: async (id, definition, expectedVersion) => {
      const updated = await this.store.queues.update(
        id,
        definition,
        expectedVersion,
        this.ctx.now(),
      );
      return updated && presentQueue(updated, this.ctx.organizationId);
    },
    remove: (id, expectedVersion) =>
      this.store.queues.softDelete(id, expectedVersion, this.ctx.now()),
    usedBy: (id) => this.store.queues.usedBy(id),
    stats: (id) => this.stats(id),
    activity: (id, window) => this.activity(id, window),
    analytics: async (id, window) => (await this.activity(id, window))?.stats,
  };

  readonly operators: HumanQueueService['operators'] = {
    list: () => this.list(),
    get: async (userId) => {
      const found = await this.store.run((tx) => tx.operator(userId));
      return found && profileOf(found);
    },
    upsert: (profile) =>
      this.store.run(async (tx) => {
        const existing = await tx.operator(profile.userId);
        await tx.putOperator(
          existing
            ? { ...existing, ...profile }
            : { ...profile, status: 'OFFLINE', statusAt: this.ctx.now() },
        );
      }),
    heartbeat: (userId, status) => this.heartbeat(userId, status),
    availability: (queue, language) => this.availability(queue, language),
    presence: (input) => this.presence(input.queueId),
  };

  private async stats(id: string): Promise<QueueStats> {
    return this.store.run(async (tx) => {
      const now = this.ctx.now();
      const queue = await tx.queue(id);
      const open = await tx.scan({ queueId: id, statuses: ['waiting', 'offered'] });
      const done = await tx.scan({ queueId: id, releasedSince: new Date(now.getTime() - DAY_MS) });
      const created = open.map((row) => row.createdAt.getTime());
      let online = 0;
      if (queue?.definition.kind === 'managed')
        for (const operator of await tx.operators())
          if (
            effectiveStatus(operator, now, this.ctx.presenceTtlSeconds) === 'AVAILABLE' &&
            mayServe(operator, { teamIds: queue.teamIds, languageMode: 'ignore' }, undefined)
          )
            online += 1;
      return {
        waiting: open.filter((row) => row.status === 'waiting').length,
        offered: open.filter((row) => row.status === 'offered').length,
        oldestWaitMs: created.length ? Math.max(0, now.getTime() - Math.min(...created)) : 0,
        online,
        handled24h: done.filter((row) => row.acceptedAt || row.releaseCode === 'handed_off').length,
      };
    });
  }

  private async activity(id: string, window: keyof typeof ACTIVITY_WINDOW_MS) {
    return this.store.run(async (tx) => {
      const now = this.ctx.now();
      const queue = await tx.queue(id);
      if (!queue || queue.deletedAt) return undefined;
      const rows = await tx.scan({
        queueId: id,
        createdSince: new Date(now.getTime() - ACTIVITY_WINDOW_MS[window]),
      });
      return queueActivity(id, window, rows, now);
    });
  }

  private get ttl() {
    return this.ctx.presenceTtlSeconds;
  }

  private async list(): Promise<OperatorRow[]> {
    return this.store.run(async (tx) => {
      const now = this.ctx.now();
      const held = await loads(tx);
      return (await tx.operators()).map((operator) => ({
        ...profileOf(operator),
        status: effectiveStatus(operator, now, this.ttl),
        ...(operator.lastSeenAt ? { lastSeenAt: operator.lastSeenAt.toISOString() } : {}),
        active: held.get(operator.userId)?.accepted ?? 0,
      }));
    });
  }

  private async heartbeat(userId: string, status?: OperatorStatus) {
    return this.store.run(async (tx) => {
      const operator = await tx.operator(userId);
      if (!operator?.enabled) return { status: 'OFFLINE' as const };
      const now = this.ctx.now();
      const next = {
        ...operator,
        lastSeenAt: now,
        ...(status ? { status, statusAt: now } : {}),
      };
      await tx.putOperator(next);
      return { status: effectiveStatus(next, now, this.ttl) };
    });
  }

  private async availability(queue: ManagedQueueRef, language?: string) {
    return this.store.run(async (tx) => {
      const now = this.ctx.now();
      const held = await loads(tx);
      let online = 0;
      let withRoom = 0;
      for (const operator of await tx.operators()) {
        if (effectiveStatus(operator, now, this.ttl) !== 'AVAILABLE') continue;
        if (!mayServe(operator, { teamIds: queue.teamIds, languageMode: queue.language }, language))
          continue;
        online += 1;
        const load = held.get(operator.userId);
        if ((load?.accepted ?? 0) + (load?.offered ?? 0) < operator.capacity) withRoom += 1;
      }
      return { online, withRoom };
    });
  }

  private async presence(queueId: string): Promise<readonly HumanPresence[]> {
    return this.store.run(async (tx) => {
      const now = this.ctx.now();
      const queue = await tx.queue(queueId);
      const held = await loads(tx);
      const teams = queue?.teamIds ?? [];
      return (await tx.operators())
        .filter((operator) =>
          mayServe(operator, { teamIds: teams, languageMode: 'ignore' }, undefined),
        )
        .map((operator) => ({
          operatorId: operator.userId,
          status: effectiveStatus(operator, now, this.ttl),
          capacity: operator.capacity,
          activeAssignments: Math.min(held.get(operator.userId)?.accepted ?? 0, operator.capacity),
          teamIds: operator.teamIds,
          updatedAt: (operator.lastSeenAt ?? operator.statusAt).toISOString(),
        }));
    });
  }
}

export const profileOf = (operator: OperatorProfile): OperatorProfile => ({
  userId: operator.userId,
  displayName: operator.displayName,
  enabled: operator.enabled,
  teamIds: operator.teamIds,
  languages: operator.languages,
  capacity: operator.capacity,
});
