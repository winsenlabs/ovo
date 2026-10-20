'use client';
import { canonicalJson } from '@winsendotai/ovo-contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
import { isRoutingDisabled } from './routing-api';

export type RecordPhase = 'loading' | 'ready' | 'error' | 'disabled' | 'missing';

export interface EditableRecordOptions<Rec, Draft> {
  load: () => Promise<{ record: Rec; version: number }>;
  toDraft: (record: Rec) => Draft;
  save: (draft: Draft, version: number) => Promise<Rec>;
  versionOf: (record: Rec) => number;
  notFoundCode: string;
  conflictCode: string;
  /** Words for a refusal the generic handling does not know; `undefined` falls back to its message. */
  saveErrorText?: (failure: unknown) => string | undefined;
}

/**
 * A versioned record the operator edits as a typed working copy: loaded with its ETag, saved with
 * `If-Match`. A save that lost a race keeps the edits and hands over the server's current record
 * (`conflict`) so the screen can show what differs and offer a choice; nothing is overwritten.
 */
export function useEditableRecord<Rec, Draft>(options: EditableRecordOptions<Rec, Draft>) {
  const {
    load,
    toDraft,
    save: persist,
    versionOf,
    notFoundCode,
    conflictCode,
    saveErrorText,
  } = options;
  const [phase, setPhase] = useState<RecordPhase>('loading');
  const [error, setError] = useState<string>();
  const [record, setRecord] = useState<Rec>();
  const [saved, setSaved] = useState<Draft>();
  const [draft, setDraft] = useState<Draft>();
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState<{ record: Rec; draft: Draft; version: number }>();

  const adopt = useCallback(
    (next: Rec, nextVersion: number) => {
      const fresh = toDraft(next);
      setRecord(next);
      setSaved(fresh);
      setDraft(fresh);
      setVersion(nextVersion);
      setConflict(undefined);
      setSaveError(undefined);
    },
    [toDraft],
  );
  const reload = useCallback(async () => {
    setPhase('loading');
    try {
      const loaded = await load();
      adopt(loaded.record, loaded.version);
      setPhase('ready');
    } catch (failure) {
      if (isRoutingDisabled(failure)) setPhase('disabled');
      else if (failure instanceof ApiError && failure.code === notFoundCode) setPhase('missing');
      else {
        setError(failure instanceof Error ? failure.message : 'It could not be loaded.');
        setPhase('error');
      }
    }
  }, [load, adopt, notFoundCode]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const dirty = Boolean(draft && saved && canonicalJson(draft) !== canonicalJson(saved));
  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setSaving(true);
    setSaveError(undefined);
    try {
      const written = await persist(draft, version);
      adopt(written, versionOf(written));
      return true;
    } catch (failure) {
      const current =
        failure instanceof ApiError && failure.code === conflictCode
          ? (failure.details?.current as Rec | undefined)
          : undefined;
      if (current)
        setConflict({ record: current, draft: toDraft(current), version: versionOf(current) });
      else if (failure instanceof ApiError && failure.code === conflictCode)
        setSaveError('It changed on the server. Reload it to continue.');
      else
        setSaveError(
          saveErrorText?.(failure) ??
            (failure instanceof Error ? failure.message : 'It could not be saved.'),
        );
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, version, persist, adopt, versionOf, conflictCode, toDraft, saveErrorText]);

  return {
    phase,
    error,
    record,
    draft,
    saved,
    version,
    dirty,
    saving,
    saveError,
    conflict,
    edit: useCallback(
      (change: (current: Draft) => Draft) => setDraft((d) => (d === undefined ? d : change(d))),
      [],
    ),
    save,
    reload,
    discard: () => setDraft(saved),
    /** After a conflict: take the server's version and lose the local edits. */
    takeTheirs: () => conflict && adopt(conflict.record, conflict.version),
    /** After a conflict: keep the edits and save them over the server's version on the next Save. */
    keepMine: () => {
      if (!conflict) return;
      setSaved(conflict.draft);
      setVersion(conflict.version);
      setConflict(undefined);
    },
  };
}
