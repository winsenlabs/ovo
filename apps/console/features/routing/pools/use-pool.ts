'use client';
import { canonicalJson } from '@winsendotai/ovo-contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { isRoutingDisabled, routingApi } from '../../../lib/data/routing-api';
import type { PoolDefinition } from '../../../lib/derive/routing-pools';
import type { PoolRecord } from '../../../lib/types/routing';

type Phase = 'loading' | 'ready' | 'error' | 'disabled' | 'missing';

/**
 * The pool editor's working copy: loaded with its ETag, edited in the browser, saved with
 * `If-Match`. A save that lost a race keeps the edits and offers the server's version.
 */
export function usePool(poolId: string) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string>();
  const [pool, setPool] = useState<PoolRecord>();
  const [saved, setSaved] = useState<PoolDefinition>();
  const [definition, setDefinition] = useState<PoolDefinition>();
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState<PoolRecord>();

  const adopt = useCallback((record: PoolRecord, next: number) => {
    setPool(record);
    setSaved(record.definition);
    setDefinition(record.definition);
    setVersion(next);
    setConflict(undefined);
    setSaveError(undefined);
  }, []);
  const reload = useCallback(async () => {
    setPhase('loading');
    try {
      const { pool: record, version: etag } = await routingApi.pool(poolId);
      adopt(record, etag);
      setPhase('ready');
    } catch (failure) {
      if (isRoutingDisabled(failure)) setPhase('disabled');
      else if (failure instanceof ApiError && failure.code === 'routing_pool_not_found') setPhase('missing');
      else {
        setError(failure instanceof Error ? failure.message : 'The pool could not be loaded.');
        setPhase('error');
      }
    }
  }, [poolId, adopt]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const dirty = Boolean(definition && saved && canonicalJson(definition) !== canonicalJson(saved));
  const save = useCallback(async () => {
    if (!definition) return false;
    setSaving(true);
    setSaveError(undefined);
    try {
      const record = await routingApi.savePool(poolId, definition, version);
      adopt({ ...record, usedBy: pool?.usedBy }, record.version);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'routing_pool_conflict') setConflict((failure.details?.current as PoolRecord | undefined) ?? pool);
      else if (failure instanceof ApiError && failure.code === 'routing_pool_name_taken') setSaveError('Another pool already has this name.');
      else if (failure instanceof ApiError && failure.code === 'routing_pool_invalid') setSaveError('The server refused the pool. Check the members and try again.');
      else setSaveError(failure instanceof Error ? failure.message : 'The pool could not be saved.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [definition, poolId, version, pool, adopt]);

  return {
    phase,
    error,
    pool,
    definition,
    version,
    dirty,
    saving,
    saveError,
    conflict,
    edit: (change: (current: PoolDefinition) => PoolDefinition) => setDefinition((d) => (d ? change(d) : d)),
    save,
    reload,
    discard: () => setDefinition(saved),
    takeTheirs: () => conflict && adopt(conflict, conflict.version),
    keepMine: () => {
      if (!conflict) return;
      setVersion(conflict.version);
      setConflict(undefined);
    },
  };
}
