'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import type { PerformanceResult } from '../../lib/operator-api';
import type { PerformanceGroupResult } from '@winsendotai/ovo-contracts';
import { autoBucket, type CompareDimension } from '../../lib/derive/performance';
import type { PerformanceFilters, PerformanceSource } from './performance-filters';

/**
 * The three cohort queries the Performance screen needs (time×stage, stage-only, compare-by),
 * extracted from `PerformanceView` to keep that module under the size gate. All three share the
 * same range/filter/source query params; only `groupBy` differs.
 */
export function usePerformanceQueries({
  fromMs,
  toMs,
  filters,
  source,
  compareDimension,
}: {
  fromMs: number;
  toMs: number;
  filters: PerformanceFilters;
  source: PerformanceSource;
  compareDimension: CompareDimension;
}) {
  const bucket = autoBucket(fromMs, toMs);
  const [primary, setPrimary] = useState<PerformanceResult | null>(null);
  const [primaryError, setPrimaryError] = useState<string>();
  const [stageOnly, setStageOnly] = useState<PerformanceGroupResult[]>([]);
  const [compareGroups, setCompareGroups] = useState<PerformanceGroupResult[]>([]);
  const [compareError, setCompareError] = useState<string>();
  const [compareLoading, setCompareLoading] = useState(false);

  const baseQuery = useCallback(
    (groupBy: string) => {
      const query = new URLSearchParams({
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        bucket,
        groupBy,
        maxGroups: '200',
      });
      if (filters.agentId) query.set('agentId', filters.agentId);
      if (filters.releaseId) query.set('releaseId', filters.releaseId);
      if (filters.provider) query.set('provider', filters.provider);
      if (filters.model) query.set('model', filters.model);
      if (filters.language) query.set('language', filters.language);
      if (filters.stage) query.set('stage', filters.stage);
      if (source !== 'all') query.set('source', source);
      return query;
    },
    [bucket, filters, fromMs, source, toMs],
  );

  const loadPrimary = useCallback(async () => {
    try {
      setPrimary(
        (await apiRequest<PerformanceResult>(`/performance?${baseQuery('time,stage')}`)).data,
      );
      setPrimaryError(undefined);
    } catch (failure) {
      setPrimary(null);
      setPrimaryError(
        failure instanceof ApiError && failure.status === 503
          ? 'Performance telemetry is not configured on this installation.'
          : failure instanceof Error
            ? failure.message
            : 'Performance evidence unavailable.',
      );
    }
  }, [baseQuery]);
  const loadStageOnly = useCallback(async () => {
    try {
      const { data } = await apiRequest<PerformanceResult>(`/performance?${baseQuery('stage')}`);
      setStageOnly(data.groups);
    } catch {
      setStageOnly([]);
    }
  }, [baseQuery]);
  const loadCompare = useCallback(async () => {
    setCompareLoading(true);
    try {
      const { data } = await apiRequest<PerformanceResult>(
        `/performance?${baseQuery(compareDimension)}`,
      );
      setCompareGroups(data.groups);
      setCompareError(undefined);
    } catch (failure) {
      setCompareGroups([]);
      setCompareError(failure instanceof Error ? failure.message : 'Comparison unavailable.');
    } finally {
      setCompareLoading(false);
    }
  }, [baseQuery, compareDimension]);

  useEffect(() => {
    void loadPrimary();
    void loadStageOnly();
  }, [loadPrimary, loadStageOnly]);
  useEffect(() => {
    void loadCompare();
  }, [loadCompare]);

  const allGroups = useMemo(() => [...(primary?.groups ?? []), ...stageOnly], [primary, stageOnly]);

  return {
    primary,
    primaryError,
    stageOnly,
    compareGroups,
    compareError,
    compareLoading,
    allGroups,
    loadPrimary,
    loadStageOnly,
    loadCompare,
  };
}
