import { randomUUID } from 'node:crypto';
import {
  routingAudioIds,
  routingPoolIds,
  type RoutingAudio,
  type RoutingPointDraft,
  type RoutingPool,
  type RoutingPoolDefinition,
  type RoutingPoint,
  type RoutingRelease,
  type RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import { RoutingPoolNameTakenError } from '@winsendotai/ovo-plugin-operations';

const WORKSPACE = 'ws-routing';

/** The routing service of design 5.2 (plugin-operations `RoutingService`), in memory, with the same optimistic-version semantics. */
export class FakeRoutingService {
  readonly enabled = true;
  private readonly poolRows = new Map<string, RoutingPool & { deletedAt?: string }>();
  private readonly audioRows = new Map<string, RoutingAudio & { bytes: Uint8Array }>();
  private readonly pointRows = new Map<string, RoutingPoint & { deleted?: boolean }>();
  private readonly releaseRows: RoutingRelease[] = [];
  /** Masked numbers pinned to a point's releases, as the inbound routes would report them. */
  readonly pinned = new Map<string, string[]>();
  private now = () => new Date().toISOString();

  private page<T extends { id: string }>(rows: T[], limit: number, cursor?: string) {
    return rows
      .filter((row) => !cursor || row.id > cursor)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit);
  }
  private nameTaken(name: string, except?: string) {
    return [...this.poolRows.values()].some(
      (row) =>
        !row.deletedAt &&
        row.id !== except &&
        row.definition.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /** Live points whose draft names `ids` (the ovo_routing_point_* link tables' view). */
  private namedBy(names: (draft: RoutingPointDraft) => string[], id: string) {
    return [...this.pointRows.values()]
      .filter((point) => !point.deleted && names(point.draft).includes(id))
      .map((point) => point.id)
      .sort();
  }

  pools = {
    list: async (limit: number, cursor?: string) =>
      this.page(
        [...this.poolRows.values()].filter((row) => !row.deletedAt),
        limit,
        cursor,
      ),
    get: async (id: string, options: { includeDeleted?: boolean } = {}) => {
      const row = this.poolRows.get(id);
      return row && (!row.deletedAt || options.includeDeleted) ? row : undefined;
    },
    usedBy: async (id: string) => this.namedBy(routingPoolIds, id),
    create: async (definition: RoutingPoolDefinition, id: string = randomUUID()) => {
      if (this.nameTaken(definition.name)) throw new RoutingPoolNameTakenError(definition.name);
      const row = {
        id,
        workspaceId: WORKSPACE,
        definition,
        version: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.poolRows.set(id, row);
      return row;
    },
    update: async (id: string, definition: RoutingPoolDefinition, expectedVersion: number) => {
      const row = await this.pools.get(id);
      if (!row || row.version !== expectedVersion) return undefined;
      if (this.nameTaken(definition.name, id)) throw new RoutingPoolNameTakenError(definition.name);
      const next = { ...row, definition, version: row.version + 1, updatedAt: this.now() };
      this.poolRows.set(id, next);
      return next;
    },
    remove: async (id: string, expectedVersion: number) => {
      const row = await this.pools.get(id);
      if (!row || row.version !== expectedVersion) return 'conflict' as const;
      const inUseBy = await this.pools.usedBy(id);
      if (inUseBy.length) return { inUseBy };
      this.poolRows.set(id, { ...row, deletedAt: this.now() });
      return 'removed' as const;
    },
  };

  audio = {
    list: async (limit: number, cursor?: string) =>
      this.page(
        [...this.audioRows.values()]
          .filter((row) => !row.deletedAt)
          .map(({ bytes: _, ...row }) => row),
        limit,
        cursor,
      ),
    get: async (id: string, options: { includeDeleted?: boolean } = {}) => {
      const row = this.audioRows.get(id);
      if (!row || (row.deletedAt && !options.includeDeleted)) return undefined;
      const { bytes: _, ...audio } = row;
      return audio;
    },
    content: async (id: string, sha256: string) => {
      const row = this.audioRows.get(id);
      return row?.sha256 === sha256 ? row.bytes : undefined;
    },
    create: async (
      input: {
        name: string;
        audio: Uint8Array;
        durationMs: number;
        sha256: string;
        source: RoutingAudio['source'];
        createdBy: string;
      },
      id: string = randomUUID(),
    ) => {
      const taken = [...this.audioRows.values()].some(
        (row) => !row.deletedAt && row.name.toLowerCase() === input.name.toLowerCase(),
      );
      if (taken) return 'name_taken' as const;
      const row = {
        id,
        workspaceId: WORKSPACE,
        name: input.name,
        codec: 'audio/x-mulaw' as const,
        sampleRate: 8000 as const,
        durationMs: input.durationMs,
        byteLength: input.audio.byteLength,
        sha256: input.sha256,
        source: input.source,
        createdAt: this.now(),
        createdBy: input.createdBy,
      };
      this.audioRows.set(id, { ...row, bytes: input.audio });
      return row;
    },
    usedBy: async (id: string) => this.namedBy(routingAudioIds, id),
    remove: async (id: string) => {
      const row = this.audioRows.get(id);
      if (!row || row.deletedAt) return 'missing' as const;
      const inUseBy = await this.audio.usedBy(id);
      if (inUseBy.length) return { inUseBy };
      this.audioRows.set(id, { ...row, deletedAt: this.now() });
      return 'removed' as const;
    },
  };

  points = {
    list: async (limit: number, cursor?: string) =>
      this.page(
        [...this.pointRows.values()].filter((row) => !row.deleted),
        limit,
        cursor,
      ),
    get: async (id: string) => {
      const row = this.pointRows.get(id);
      return row && !row.deleted ? row : undefined;
    },
    create: async (draft: RoutingPointDraft) => {
      const row = {
        id: randomUUID(),
        workspaceId: WORKSPACE,
        draft,
        draftVersion: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.pointRows.set(row.id, row);
      return row;
    },
    update: async (id: string, draft: RoutingPointDraft, expectedVersion: number) => {
      const row = await this.points.get(id);
      if (!row || row.draftVersion !== expectedVersion) return undefined;
      const next = { ...row, draft, draftVersion: row.draftVersion + 1, updatedAt: this.now() };
      this.pointRows.set(id, next);
      return next;
    },
    remove: async (id: string, expectedVersion: number) => {
      const row = await this.points.get(id);
      if (!row || row.draftVersion !== expectedVersion) return 'conflict' as const;
      const pinnedBy = this.pinned.get(id) ?? [];
      if (pinnedBy.length) return { pinnedBy };
      this.pointRows.set(id, { ...row, deleted: true });
      return 'removed' as const;
    },
  };

  releases = {
    create: async (input: {
      pointId: string;
      draftVersion: number;
      snapshot: RoutingReleaseSnapshot;
      digest: string;
      createdBy: string;
    }) => {
      const point = await this.points.get(input.pointId);
      if (!point || point.draftVersion !== input.draftVersion) return undefined;
      const version =
        this.releaseRows.filter((row) => row.routingPointId === input.pointId).length + 1;
      const row: RoutingRelease = {
        id: randomUUID(),
        workspaceId: WORKSPACE,
        routingPointId: input.pointId,
        version,
        draftVersion: input.draftVersion,
        snapshot: input.snapshot,
        digest: input.digest,
        createdAt: this.now(),
        createdBy: input.createdBy,
      };
      this.releaseRows.push(row);
      return row;
    },
    get: async (id: string) => this.releaseRows.find((row) => row.id === id),
    list: async (pointId: string, limit: number) =>
      this.releaseRows
        .filter((row) => row.routingPointId === pointId)
        .sort((a, b) => b.version - a.version)
        .slice(0, limit),
  };

  claims = {
    claim: async () => ({ kind: 'full' as const }),
    release: async () => 0,
    active: async () => ({}),
  };
}
