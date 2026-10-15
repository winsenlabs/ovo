import { createHash, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  ROUTING_AUDIO_LIMITS,
  RoutingAudioName,
  RoutingAudioSource,
  type RoutingAudio,
} from '@winsendotai/ovo-contracts';
import { boundedLimit, transaction } from '../database.ts';
import { isUniqueViolation, pointsNaming, uuidOrNull } from './rows.ts';

const NAME_INDEX = 'ovo_routing_audio_name_idx';
const COLUMNS = `organization_id, id, name, codec, sample_rate, duration_ms, byte_length, sha256,
  source, created_by, created_at, deleted_at`;

interface AudioRow extends QueryResultRow {
  organization_id: string;
  id: string;
  name: string;
  duration_ms: number;
  byte_length: number;
  sha256: string;
  source: RoutingAudio['source'];
  created_by: string;
  created_at: Date;
  deleted_at: Date | null;
}

export interface RoutingAudioInput {
  name: string;
  /** 8 kHz mu-law, one byte per sample. */
  audio: Uint8Array;
  durationMs: number;
  /** sha256 of `audio`, hex; checked against the bytes. */
  sha256: string;
  source: RoutingAudio['source'];
  createdBy: string;
}

function present(row: AudioRow): RoutingAudio {
  return {
    id: row.id,
    workspaceId: row.organization_id,
    name: row.name,
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    durationMs: Number(row.duration_ms),
    byteLength: Number(row.byte_length),
    sha256: row.sha256,
    source: row.source,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {}),
  };
}

/**
 * Hold clips (R2): immutable bytes, soft-deleted so a release that pinned one by its digest keeps
 * playing it. A clip a live point's draft names cannot be deleted (`ovo_routing_point_audio`).
 */
export class RoutingAudioStore {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  /** Metadata only, ordered by id; deleted clips are left out. */
  async list(limit: number, cursor?: string): Promise<RoutingAudio[]> {
    const result = await this.pool.query<AudioRow>(
      `SELECT ${COLUMNS} FROM ovo_routing_audio
       WHERE organization_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id LIMIT $3`,
      [this.organizationId, uuidOrNull(cursor), boundedLimit(limit)],
    );
    return result.rows.map(present);
  }

  async get(id: string, options: { includeDeleted?: boolean } = {}) {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<AudioRow>(
      `SELECT ${COLUMNS} FROM ovo_routing_audio
       WHERE organization_id = $1 AND id = $2 AND ($3 OR deleted_at IS NULL)`,
      [this.organizationId, id, options.includeDeleted === true],
    );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  /** The bytes, deleted or not (pinned releases); undefined when unknown or the digest differs. */
  async content(id: string, sha256: string): Promise<Uint8Array | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<{ audio: Buffer }>(
      'SELECT audio FROM ovo_routing_audio WHERE organization_id = $1 AND id = $2 AND sha256 = $3',
      [this.organizationId, id, sha256],
    );
    const audio = result.rows[0]?.audio;
    return audio ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength) : undefined;
  }

  /** `name_taken` when an active clip has the name (case-insensitive). Throws on invalid input. */
  async create(input: RoutingAudioInput): Promise<RoutingAudio | 'name_taken'> {
    const name = RoutingAudioName.parse(input.name);
    const source = RoutingAudioSource.parse(input.source);
    const { audio, durationMs } = input;
    if (createHash('sha256').update(audio).digest('hex') !== input.sha256)
      throw new TypeError('Routing audio sha256 does not match its bytes');
    if (
      audio.byteLength < ROUTING_AUDIO_LIMITS.minBytes ||
      audio.byteLength > ROUTING_AUDIO_LIMITS.maxBytes ||
      !Number.isInteger(durationMs) ||
      durationMs < ROUTING_AUDIO_LIMITS.minMs ||
      durationMs > ROUTING_AUDIO_LIMITS.maxMs
    )
      throw new RangeError('Routing audio must be 0.1-300 s of 8 kHz mu-law');
    if (!input.createdBy.trim()) throw new TypeError('createdBy is required');
    try {
      const result = await this.pool.query<AudioRow>(
        `INSERT INTO ovo_routing_audio (organization_id, id, name, codec, sample_rate, duration_ms,
           byte_length, sha256, audio, source, created_by)
         VALUES ($1, $2, $3, 'audio/x-mulaw', 8000, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING ${COLUMNS}`,
        [
          this.organizationId,
          randomUUID(),
          name,
          durationMs,
          audio.byteLength,
          input.sha256,
          Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength),
          JSON.stringify(source),
          input.createdBy,
        ],
      );
      return present(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error, NAME_INDEX)) return 'name_taken';
      throw error;
    }
  }

  /** Live point ids whose current draft names the clip. */
  usedBy(id: string): Promise<string[]> {
    return pointsNaming(this.pool, this.organizationId, LINK, id);
  }

  /** Soft delete; refused while a live point's draft names the clip. */
  async remove(id: string): Promise<'removed' | 'missing' | { inUseBy: string[] }> {
    if (!uuidOrNull(id)) return 'missing';
    return transaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT 1 FROM ovo_routing_audio
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [this.organizationId, id],
      );
      if (!locked.rowCount) return 'missing';
      const users = await pointsNaming(client, this.organizationId, LINK, id);
      if (users.length) return { inUseBy: users };
      await client.query(
        'UPDATE ovo_routing_audio SET deleted_at = now() WHERE organization_id = $1 AND id = $2',
        [this.organizationId, id],
      );
      return 'removed';
    });
  }
}

const LINK = { table: 'ovo_routing_point_audio', column: 'audio_id' } as const;
