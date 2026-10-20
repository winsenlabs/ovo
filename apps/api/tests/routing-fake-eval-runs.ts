import { randomUUID } from 'node:crypto';
import type {
  RoutingEvalCase,
  RoutingEvalRun,
  RoutingEvalRunSummary,
  RoutingRelease,
  RoutingScorecard,
} from '@winsendotai/ovo-contracts';

/** The eval-run store of `RoutingService.evalRuns` (plugin-operations), in memory. */
export class FakeEvalRuns {
  constructor(
    private readonly releases: () => RoutingRelease[],
    private readonly now: () => string,
  ) {}

  private readonly runRows: (RoutingEvalRun & { corpus: RoutingEvalCase[]; deleted?: boolean })[] =
    [];
  readonly store = {
    create: async (input: {
      routingReleaseId: string;
      name: string;
      corpusDigest: string;
      scorecard: RoutingScorecard;
      corpus: readonly RoutingEvalCase[];
      createdBy: string;
    }) => {
      const release = this.releases().find((row) => row.id === input.routingReleaseId);
      if (!release) return undefined;
      const card = input.scorecard;
      const run = {
        id: randomUUID(),
        name: input.name,
        routingReleaseId: release.id,
        routingPointId: release.routingPointId,
        releaseVersion: release.version,
        createdAt: this.now(),
        createdBy: input.createdBy,
        engineMode: 'recorded' as const,
        caseCount: input.corpus.length,
        headline: {
          passed: card.totals.passed,
          total: card.totals.cases,
          accuracy: card.accuracy.overall.rate,
          fallbackRate: card.fallbackRate.rate,
          clarifyRate: card.clarifyRate.rate,
        },
        corpusDigest: input.corpusDigest,
        scorecard: card,
        corpus: [...input.corpus],
      };
      this.runRows.push(run);
      const { corpus: _, deleted: __, ...wire } = run as typeof run & { deleted?: boolean };
      return wire as RoutingEvalRun;
    },
    list: async (limit: number, cursor?: string): Promise<RoutingEvalRunSummary[]> => {
      const live = this.runRows.filter((row) => !row.deleted).reverse();
      const from = cursor ? live.findIndex((row) => row.id === cursor) + 1 : 0;
      return live
        .slice(from, from + limit)
        .map(({ scorecard: _, corpus: __, corpusDigest: ___, ...row }) => row);
    },
    get: async (id: string) => {
      const row = this.runRows.find((found) => found.id === id && !found.deleted);
      if (!row) return undefined;
      const { corpus: _, ...wire } = row;
      return wire as RoutingEvalRun;
    },
    corpus: async (id: string) => this.runRows.find((row) => row.id === id && !row.deleted)?.corpus,
    softDelete: async (id: string) => {
      const row = this.runRows.find((found) => found.id === id && !found.deleted);
      if (row) row.deleted = true;
      return row !== undefined;
    },
  };
}

/** `RoutingService.releases.latest`: the newest release of each point, without its snapshot. */
export function latestReleases(rows: readonly RoutingRelease[], pointIds: readonly string[]) {
  const found = new Map<
    string,
    { id: string; version: number; digest: string; draftVersion: number; createdAt: string }
  >();
  for (const row of rows) {
    const held = found.get(row.routingPointId);
    if (pointIds.includes(row.routingPointId) && (!held || row.version > held.version))
      found.set(row.routingPointId, {
        id: row.id,
        version: row.version,
        digest: row.digest,
        draftVersion: row.draftVersion,
        createdAt: row.createdAt,
      });
  }
  return found;
}
