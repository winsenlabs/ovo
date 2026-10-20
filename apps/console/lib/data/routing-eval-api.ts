'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, items } from '../api';

// Wire shapes of `/v1/routing/eval-runs` (Wave 18 design 3.3 and 3.5). Offline runs score the
// tree, the rules and the pools against scripted engine answers: they say nothing about model quality.
export interface Rate {
  correct: number;
  total: number;
  rate: number | null;
}

export const ENGINE_KEYS = ['rules', 'decision', 'llm', 'external', 'context'] as const;
export type EngineKey = (typeof ENGINE_KEYS)[number];

export interface EngineCounts {
  attempts: number;
  matched: number;
  no_match: number;
  low_confidence: number;
  timeout: number;
  error: number;
  disabled: number;
}

export interface ConfusionMatrix {
  labels: string[];
  matrix: number[][];
  correct: number;
  total: number;
}

export const ACCURACY_FIELDS = [
  'overall',
  'status',
  'path',
  'node',
  'branch',
  'pool',
  'member',
  'agent',
  'queue',
  'language',
] as const;

export interface RoutingScorecard {
  schema: string;
  engineMode: 'recorded' | 'live';
  corpus: { name: string; digest: string; cases: number };
  routing: { pointId: string | null; routingReleaseId: string | null; digest: string };
  totals: { cases: number; passed: number; failed: number };
  accuracy: Record<(typeof ACCURACY_FIELDS)[number], Rate>;
  fallbackRate: Rate & { byStep: Record<string, number> };
  clarifyRate: Rate;
  endRate: Rate;
  perEngine: Partial<Record<EngineKey, EngineCounts>>;
  confusion: Record<string, ConfusionMatrix>;
  perNode: { node: string; cases: number; decided: number; correct: number; fallbacks: number }[];
  byTag: Record<string, { cases: number; passed: number }>;
  failures: {
    id: string;
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
    diff: string[];
  }[];
  ms: { total: number; p50: number; p95: number };
}

export interface RoutingEvalRunSummary {
  id: string;
  name: string;
  routingReleaseId: string;
  routingPointId: string;
  releaseVersion: number;
  createdAt: string;
  createdBy: string;
  engineMode: 'recorded' | 'live';
  caseCount: number;
  headline: {
    passed: number;
    total: number;
    accuracy: number | null;
    fallbackRate: number | null;
    clarifyRate: number | null;
  };
}

export interface RoutingEvalRun extends RoutingEvalRunSummary {
  corpusDigest: string;
  scorecard: RoutingScorecard;
}

export interface RoutingReleaseOption {
  id: string;
  label: string;
}

const run = (id: string) => `/routing/eval-runs/${encodeURIComponent(id)}`;

export const routingEvalApi = {
  list: async () =>
    items<RoutingEvalRunSummary>((await apiRequest<unknown>('/routing/eval-runs?limit=100')).data),
  get: async (id: string) => (await apiRequest<RoutingEvalRun>(run(id))).data,
  create: async (body: {
    routingReleaseId: string;
    name: string;
    cases: unknown[];
    assume?: { transferEnabled?: boolean; humanQueueEnabled?: boolean };
  }) =>
    (await apiRequest<RoutingEvalRun>('/routing/eval-runs', {
      method: 'POST',
      body: JSON.stringify(body),
    })).data,
  remove: async (id: string) => void (await apiRequest(run(id), { method: 'DELETE' })),
};

/** A published release per option, labelled by its point and version (newest releases first). */
export async function loadRoutingReleaseOptions(): Promise<RoutingReleaseOption[]> {
  const points = items<{ id: string; draft?: { name?: string } }>(
    (await apiRequest<unknown>('/routing/points?limit=50')).data,
  );
  const lists = await Promise.allSettled(
    points.map(async (point) => ({
      point,
      releases: items<{ id: string; version: number }>(
        (
          await apiRequest<unknown>(
            `/routing/points/${encodeURIComponent(point.id)}/releases?view=summary&limit=20`,
          )
        ).data,
      ),
    })),
  );
  return lists.flatMap((result) =>
    result.status === 'fulfilled'
      ? result.value.releases.map((release) => ({
          id: release.id,
          label: `${result.value.point.draft?.name ?? result.value.point.id} · v${release.version}`,
        }))
      : [],
  );
}

export type RoutingEvalState =
  | { status: 'loading' }
  | { status: 'ready'; runs: RoutingEvalRunSummary[] }
  /** Routing is switched off here (404 `routing_disabled`), or has no operations database. */
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string };

/** The stored routing eval runs, newest first, reloadable. */
export function useRoutingEvalRuns(): RoutingEvalState & { refresh: () => void } {
  const [state, setState] = useState<RoutingEvalState>({ status: 'loading' });
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    setState({ status: 'loading' });
    routingEvalApi
      .list()
      .then((runs) => generation.current === request && setState({ status: 'ready', runs }))
      .catch((failure) => {
        if (generation.current !== request) return;
        const dark = failure instanceof ApiError && failure.status === 404;
        setState(
          dark
            ? { status: 'unavailable', message: 'Routing is not enabled here.' }
            : {
                status: 'error',
                message: failure instanceof Error ? failure.message : 'Routing runs could not be loaded.',
              },
        );
      });
  }, []);
  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  return { ...state, refresh };
}
