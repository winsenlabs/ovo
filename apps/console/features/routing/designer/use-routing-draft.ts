'use client';
import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { routingApi } from '../../../lib/data/routing-api';
import { useEditableRecord } from '../../../lib/data/use-editable-record';
import { indexIssues, type DraftIssue } from '../../../lib/derive/routing-anchor';
import { loadDraft } from '../../../lib/derive/routing-defaults';
import { routingDiff } from '../../../lib/derive/routing-diff';
import { clientIssues, hasSchemaErrors, mergeIssues } from '../../../lib/derive/routing-issues';
import type { PointRecord, RoutingChange } from '../../../lib/types/routing';

export const VALIDATE_DEBOUNCE_MS = 800;

export interface Conflict {
  theirs: RoutingPointDraft;
  version: number;
  /** What the working copy changes on top of the server's draft. */
  changes: RoutingChange[];
}

const toDraft = (record: PointRecord) => loadDraft(record.draft).draft;
const versionOf = (record: PointRecord) => record.draftVersion;
const saveErrorText = (failure: unknown) =>
  failure instanceof ApiError && failure.code === 'routing_draft_invalid'
    ? 'The server refused the draft. Fix the problems listed and try again.'
    : undefined;

/**
 * The designer's working copy of one routing point. Edits are typed and instant (zod and the
 * structural checks run in the browser on every change); the server's resolution checks run
 * debounced. Save sends `If-Match`; a 409 keeps the working copy and shows what the server
 * changed, never overwriting either side without a choice.
 */
export function useRoutingDraft(pointId: string) {
  const load = useCallback(async () => {
    const { point, version } = await routingApi.point(pointId);
    return { record: point, version };
  }, [pointId]);
  const save = useCallback((draft: RoutingPointDraft, version: number) => routingApi.savePoint(pointId, draft, version), [pointId]);
  const base = useEditableRecord<PointRecord, RoutingPointDraft>({
    load,
    toDraft,
    save,
    versionOf,
    notFoundCode: 'routing_point_not_found',
    conflictCode: 'routing_point_conflict',
    saveErrorText,
  });
  const { draft, phase } = base;
  const [serverIssues, setServerIssues] = useState<DraftIssue[]>([]);
  const [validating, setValidating] = useState(false);
  const run = useRef(0);
  const local = useMemo(() => (draft ? clientIssues(draft) : []), [draft]);

  // Resolution checks (releases, pools, credentials, queues) need the server; run them once the
  // draft settles, and not at all while the schema itself is broken.
  useEffect(() => {
    if (!draft || phase !== 'ready' || hasSchemaErrors(local)) return;
    const mine = ++run.current;
    const timer = setTimeout(async () => {
      setValidating(true);
      try {
        const found = await routingApi.validate(pointId, draft);
        if (run.current === mine) setServerIssues(found.map((i) => ({ ...i, source: 'server' as const })));
      } catch {
        if (run.current === mine) setServerIssues([]);
      } finally {
        if (run.current === mine) setValidating(false);
      }
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, local, phase, pointId]);

  const issues = useMemo(() => mergeIssues(local, serverIssues), [local, serverIssues]);
  const index = useMemo(() => (draft ? indexIssues(draft, issues) : undefined), [draft, issues]);
  const conflict: Conflict | undefined = useMemo(
    () => (base.conflict && draft ? { theirs: base.conflict.draft, version: base.conflict.version, changes: routingDiff(base.conflict.draft, draft) } : undefined),
    [base.conflict, draft],
  );
  return { ...base, point: base.record, conflict, issues, index, validating };
}

export type RoutingDraftApi = ReturnType<typeof useRoutingDraft>;
