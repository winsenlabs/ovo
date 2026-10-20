'use client';
import { useCallback, useRef } from 'react';
import { ApiError } from '../../../lib/api';
import { routingApi } from '../../../lib/data/routing-api';
import { useEditableRecord } from '../../../lib/data/use-editable-record';
import type { PoolDefinition } from '../../../lib/derive/routing-pools';
import type { PoolRecord } from '../../../lib/types/routing';

const toDraft = (record: PoolRecord) => record.definition;
const versionOf = (record: PoolRecord) => record.version;
const saveErrorText = (failure: unknown) =>
  failure instanceof ApiError && failure.code === 'routing_pool_name_taken'
    ? 'Another pool already has this name.'
    : failure instanceof ApiError && failure.code === 'routing_pool_invalid'
      ? 'The server refused the pool. Check the members and try again.'
      : undefined;

/** The pool editor's working copy: loaded with its ETag, edited in the browser, saved with `If-Match`. */
export function usePool(poolId: string) {
  const load = useCallback(async () => {
    const { pool, version } = await routingApi.pool(poolId);
    return { record: pool, version };
  }, [poolId]);
  // A save answers with the pool only; who uses it is read at load, so it is carried across a save.
  const usedBy = useRef<string[] | undefined>(undefined);
  const save = useCallback(
    async (definition: PoolDefinition, version: number): Promise<PoolRecord> => ({
      ...(await routingApi.savePool(poolId, definition, version)),
      usedBy: usedBy.current,
    }),
    [poolId],
  );
  const base = useEditableRecord<PoolRecord, PoolDefinition>({
    load,
    toDraft,
    save,
    versionOf,
    notFoundCode: 'routing_pool_not_found',
    conflictCode: 'routing_pool_conflict',
    saveErrorText,
  });
  usedBy.current = base.record?.usedBy;
  return { ...base, pool: base.record, definition: base.draft, conflict: base.conflict?.record };
}
