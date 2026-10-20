'use client';
import { canonicalJson, type RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { isRoutingDisabled, routingApi } from '../../../lib/data/routing-api';
import { indexIssues, type DraftIssue } from '../../../lib/derive/routing-anchor';
import { loadDraft } from '../../../lib/derive/routing-defaults';
import { routingDiff } from '../../../lib/derive/routing-diff';
import { clientIssues, hasSchemaErrors, mergeIssues } from '../../../lib/derive/routing-issues';
import type { PointRecord, RoutingChange } from '../../../lib/types/routing';

export const VALIDATE_DEBOUNCE_MS = 800;

type Phase = 'loading' | 'ready' | 'error' | 'disabled' | 'missing';
export interface Conflict {
  theirs: RoutingPointDraft;
  version: number;
  /** What the working copy changes on top of the server's draft. */
  changes: RoutingChange[];
}

/**
 * The designer's working copy of one routing point. Edits are typed and instant (zod and the
 * structural checks run in the browser on every change); the server's resolution checks run
 * debounced. Save sends `If-Match`; a 409 keeps the working copy and shows what the server
 * changed, never overwriting either side without a choice.
 */
export function useRoutingDraft(pointId: string) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string>();
  const [point, setPoint] = useState<PointRecord>();
  const [saved, setSaved] = useState<RoutingPointDraft>();
  const [draft, setDraft] = useState<RoutingPointDraft>();
  const [version, setVersion] = useState(0);
  const [serverIssues, setServerIssues] = useState<DraftIssue[]>([]);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState<Conflict>();
  const run = useRef(0);

  const adopt = useCallback((record: PointRecord, nextVersion: number) => {
    const { draft: loaded } = loadDraft(record.draft);
    setPoint(record);
    setSaved(loaded);
    setDraft(loaded);
    setVersion(nextVersion);
    setConflict(undefined);
    setSaveError(undefined);
  }, []);

  const reload = useCallback(async () => {
    setPhase('loading');
    try {
      const { point: record, version: etag } = await routingApi.point(pointId);
      adopt(record, etag);
      setPhase('ready');
    } catch (failure) {
      if (isRoutingDisabled(failure)) setPhase('disabled');
      else if (failure instanceof ApiError && failure.code === 'routing_point_not_found') setPhase('missing');
      else {
        setError(failure instanceof Error ? failure.message : 'The routing point could not be loaded.');
        setPhase('error');
      }
    }
  }, [pointId, adopt]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const dirty = Boolean(draft && saved && canonicalJson(draft) !== canonicalJson(saved));
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

  const edit = useCallback(
    (change: (current: RoutingPointDraft) => RoutingPointDraft) =>
      setDraft((current) => (current ? change(current) : current)),
    [],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setSaving(true);
    setSaveError(undefined);
    try {
      const record = await routingApi.savePoint(pointId, draft, version);
      adopt(record, record.draftVersion);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'routing_point_conflict') {
        const current = failure.details?.current as PointRecord | undefined;
        if (current) {
          const theirs = loadDraft(current.draft).draft;
          setConflict({ theirs, version: current.draftVersion, changes: routingDiff(theirs, draft) });
        } else setSaveError('The routing point changed on the server. Reload it to continue.');
      } else if (failure instanceof ApiError && failure.code === 'routing_draft_invalid')
        setSaveError('The server refused the draft. Fix the problems listed and try again.');
      else setSaveError(failure instanceof Error ? failure.message : 'The routing point could not be saved.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, pointId, version, adopt]);

  return {
    phase,
    error,
    point,
    draft,
    saved,
    version,
    dirty,
    issues,
    index,
    validating,
    saving,
    saveError,
    conflict,
    edit,
    save,
    reload,
    /** Drop the working copy for the last saved one. */
    discard: () => setDraft(saved),
    /** After a conflict: take the server's draft and lose the local edits. */
    takeTheirs: () => {
      if (!conflict) return;
      setSaved(conflict.theirs);
      setDraft(conflict.theirs);
      setVersion(conflict.version);
      setConflict(undefined);
    },
    /** After a conflict: keep the edits and save them over the server's version on the next Save. */
    keepMine: () => {
      if (!conflict) return;
      setSaved(conflict.theirs);
      setVersion(conflict.version);
      setConflict(undefined);
    },
  };
}

export type RoutingDraftApi = ReturnType<typeof useRoutingDraft>;
