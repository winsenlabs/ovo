import type { ReactNode } from 'react';
import type { RecordPhase } from '../../lib/data/use-editable-record';
import { EmptyStateV2, ErrorState } from '../ui/feedback-v2';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { PageHeader } from '../ui/layout';

/**
 * What an editor page shows before there is a record to edit: a skeleton while it loads, "does not
 * exist" for a 404, the error with a retry. `undefined` means the record is ready.
 */
export function editorGate({
  phase,
  title,
  what,
  kpis,
  error,
  onRetry,
}: {
  phase: RecordPhase;
  title: string;
  what: string;
  kpis: readonly string[];
  error?: string;
  onRetry: () => void;
}): ReactNode | undefined {
  if (phase === 'ready') return undefined;
  const header = <PageHeader eyebrow="Routing" title={title} />;
  return (
    <div className="ds-stack">
      {header}
      {phase === 'loading' ? (
        <KpiStrip>
          {kpis.map((label) => (
            <KpiCard key={label} label={label} loading />
          ))}
        </KpiStrip>
      ) : phase === 'missing' ? (
        <EmptyStateV2 variant="filtered" title={`This ${what} does not exist`} action={<a className="button" href="/routing">Back to routing</a>}>
          It may have been deleted.
        </EmptyStateV2>
      ) : (
        <ErrorState message={error ?? `The ${what} could not be loaded.`} onRetry={onRetry} />
      )}
    </div>
  );
}

/** Save and discard for a working copy; nothing for a viewer. */
export function SaveActions({
  canEdit,
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  canEdit: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!canEdit) return null;
  return (
    <>
      <button type="button" className="button" disabled={!dirty || saving} onClick={onSave}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {dirty && (
        <button type="button" className="button" onClick={onDiscard}>
          Discard changes
        </button>
      )}
    </>
  );
}
