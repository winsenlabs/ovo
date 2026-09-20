import type { ObjectBackend } from './backend.ts';
import type { RecordingRepository } from './repository.ts';
import type { RetentionCursor } from './types.ts';

export interface RetentionSweepResult {
  examined: number;
  tombstoned: number;
  cleaned: number;
  failed: number;
  nextCursor?: RetentionCursor;
}

export class RecordingRetentionService {
  constructor(
    private readonly repository: RecordingRepository,
    private readonly objects: ObjectBackend,
    private readonly clock: () => number = Date.now,
  ) {}

  async sweep(
    input: { cursor?: RetentionCursor; limit?: number } = {},
  ): Promise<RetentionSweepResult> {
    const limit = boundedLimit(input.limit);
    const at = new Date(this.clock()).toISOString();
    const page = await this.repository.pageExpired(at, input.cursor, limit);
    let tombstoned = 0;
    for (const artifact of page.items) {
      await this.repository.tombstone(
        artifact.workspaceId,
        artifact.callId,
        artifact.id,
        'retention',
        at,
      );
      tombstoned += 1;
    }
    const cleanup = await this.cleanup({ limit });
    return {
      examined: page.items.length,
      tombstoned,
      cleaned: cleanup.cleaned,
      failed: cleanup.failed,
      nextCursor: page.nextCursor,
    };
  }

  async cleanup(input: { limit?: number } = {}): Promise<{ cleaned: number; failed: number }> {
    const rows = await this.repository.pendingTombstones(boundedLimit(input.limit));
    let cleaned = 0;
    let failed = 0;
    for (const tombstone of rows) {
      const keys = await this.repository.objectKeysForDeletion(tombstone.artifactId);
      let error: string | undefined;
      for (const key of keys) {
        try {
          await this.objects.delete(key);
        } catch (cause) {
          error = safeError(cause);
          break;
        }
      }
      const recorded = await this.repository.recordCleanup(
        tombstone.artifactId,
        new Date(this.clock()).toISOString(),
        error,
        tombstone.attempts,
      );
      if (!recorded) continue;
      if (error) failed += 1;
      else cleaned += 1;
    }
    return { cleaned, failed };
  }
}

function boundedLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Retention sweep limit must be from 1 to 100');
  return limit;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Object deletion failed').slice(0, 500);
}
