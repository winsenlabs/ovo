'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, type SessionIdentity } from '../../lib/api';
import { useApiList } from '../../lib/data/use-list';
import { useFormAction } from '../forms/use-form-action';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { DataTableV2 } from '../ui/data-table-v2';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { EmptyStateV2, ErrorState, InlineAlert } from '../ui/feedback-v2';
import { ChartFrame } from '../charts/chart-frame';
import { Donut } from '../charts/donut';
import { donutSlices } from '../../lib/derive/operations';
import { DoNotCallImport } from './do-not-call-import';
import { DoNotCallLookup } from './do-not-call-lookup';
import { DoNotCallRemoveDialog } from './do-not-call-remove-dialog';
import {
  lockedUntil,
  suppressionColumns,
  SOURCE_LABEL,
  type DoNotCallEntry,
} from './suppressions-view-columns';

export { lockedUntil };

const SEVEN_DAYS_MS = 7 * 86_400_000;

export function SuppressionsView({ role }: { role: SessionIdentity['role'] }) {
  const formAction = useFormAction();
  const {
    rows,
    loading,
    error,
    setError,
    reload: load,
  } = useApiList<DoNotCallEntry>('/operations/suppressions?limit=100', {
    unavailableMessage: 'The do-not-call list is not configured on this installation.',
    fallbackMessage: 'Suppressions unavailable.',
  });
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<'add' | 'import' | null>(null);
  const [removing, setRemoving] = useState<DoNotCallEntry>();
  const [removalReason, setRemovalReason] = useState('');
  const [removeError, setRemoveError] = useState<string>();

  async function add(event: FormEvent<HTMLFormElement>) {
    setBusy(true);
    setError(undefined);
    try {
      await formAction(event, async (values) => {
        await apiRequest('/operations/suppressions', {
          method: 'POST',
          body: JSON.stringify({
            phoneNumber: values.get('phoneNumber'),
            reason: values.get('reason'),
          }),
        });
        setDrawer(null);
        await load();
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Suppression could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    setRemoveError(undefined);
    try {
      await apiRequest(
        `/operations/suppressions/${encodeURIComponent(removing.phoneNumber)}?reason=${encodeURIComponent(removalReason)}`,
        { method: 'DELETE' },
      );
      setRemoving(undefined);
      setRemovalReason('');
      await load();
    } catch (failure) {
      setRemoveError(
        failure instanceof ApiError && failure.code === 'opt_out_locked'
          ? `${removing.phoneNumber} opted out; it stays listed until ${new Date(String(failure.details?.lockUntil)).toLocaleDateString()}.`
          : failure instanceof Error
            ? failure.message
            : 'Suppression could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const needle = search.trim();
    return needle ? rows.filter((row) => row.phoneNumber.includes(needle)) : rows;
  }, [rows, search]);

  const now = Date.now();
  const lockedCount = rows.filter((row) => lockedUntil(row, now)).length;
  const addedLast7d = rows.filter((row) => now - Date.parse(row.createdAt) < SEVEN_DAYS_MS).length;
  const sourceSlices = useMemo(
    () =>
      donutSlices(
        rows,
        Object.keys(SOURCE_LABEL),
        (row) => row.source ?? 'manual',
        (key) => SOURCE_LABEL[key as keyof typeof SOURCE_LABEL],
      ),
    [rows],
  );
  const columns = useMemo(
    () =>
      suppressionColumns({
        role,
        busy,
        now,
        onRemove: (row) => {
          setRemoving(row);
          setRemovalReason('');
          setRemoveError(undefined);
        },
      }),
    [role, busy, now],
  );

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Operations"
        title="Do-not-call list"
        description="Campaign admission, manual and test calls refuse a listed number, and the worker rechecks it immediately before every carrier dial. Callers who say “stop calling me” are added automatically."
        actions={
          <div className="button-row">
            <button
              className="button"
              type="button"
              onClick={() => setDrawer('import')}
              disabled={role === 'viewer'}
            >
              Import
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => setDrawer('add')}
              disabled={role === 'viewer'}
            >
              Add number
            </button>
          </div>
        }
        onRefresh={() => void load()}
        refreshing={loading}
      />
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && (
        <div className="ds-stack">
          <KpiStrip>
            <KpiCard label="Listed" value={loading ? undefined : rows.length} loading={loading} />
            <KpiCard
              label="In 90-day lock"
              value={loading ? undefined : lockedCount}
              loading={loading}
            />
            <KpiCard
              label="Added, last 7d"
              value={loading ? undefined : addedLast7d}
              loading={loading}
            />
          </KpiStrip>
          <SectionCard title="By source" padding="data">
            <ChartFrame
              ariaLabel="Suppressions by source"
              // Taller than the donut itself: at narrow widths the legend wraps below the ring,
              // and the frame's measured wrapper clips anything past its fixed height.
              height={280}
              loading={loading}
              empty={!loading && sourceSlices.length === 0}
              tableRows={sourceSlices.length}
              tableColumns={[
                { header: 'Source', cell: (i) => sourceSlices[i]?.label },
                { header: 'Count', cell: (i) => sourceSlices[i]?.value },
              ]}
              renderChart={() => <Donut slices={sourceSlices} size={160} />}
            />
          </SectionCard>
        </div>
      )}
      {/* A real error with nothing already on screen has nothing honest to show below the
          banner above; once rows are loaded, a later background error still leaves the last
          good list up rather than replacing it with a false "no numbers" claim. */}
      {!(error && rows.length === 0) && (
        <SectionCard
          title="Listed numbers"
          padding="flush"
          description={loading ? undefined : `${filtered.length} of ${rows.length} shown`}
          actions={
            <div className="ds-filter-row">
              <input
                type="search"
                aria-label="Filter listed numbers"
                placeholder="Filter by number"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <DoNotCallLookup />
            </div>
          }
        >
          <DataTableV2
            key={loading ? 'loading' : filtered.length === 0 ? 'empty' : 'data'}
            label="Do-not-call numbers"
            rows={filtered}
            columns={columns}
            rowKey={(row) => row.phoneNumber}
            loading={loading}
            empty={
              <EmptyStateV2
                variant={search ? 'filtered' : 'first-run'}
                title={search ? 'No match' : 'No listed numbers'}
              >
                {search
                  ? 'No number matches this filter.'
                  : 'The API returned an empty list. This does not bypass campaign-level attempt limits.'}
              </EmptyStateV2>
            }
          />
        </SectionCard>
      )}
      <Drawer open={drawer === 'add'} onClose={() => setDrawer(null)} title="Add number">
        <form className="stack" onSubmit={add}>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
          <FormField id="suppression-phone" label="E.164 phone number">
            {(control) => (
              <input {...control} name="phoneNumber" type="tel" placeholder="+91…" required />
            )}
          </FormField>
          <FormField id="suppression-reason" label="Reason">
            {(control) => <input {...control} name="reason" required maxLength={1000} />}
          </FormField>
          <div className="button-row">
            <button className="button primary" disabled={role === 'viewer' || busy}>
              {busy ? 'Saving…' : 'Add number'}
            </button>
            <button className="button" type="button" onClick={() => setDrawer(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Drawer>
      <Drawer open={drawer === 'import'} onClose={() => setDrawer(null)} title="Import numbers">
        <DoNotCallImport role={role} onImported={load} />
      </Drawer>
      <DoNotCallRemoveDialog
        phoneNumber={removing?.phoneNumber}
        reason={removalReason}
        onReasonChange={setRemovalReason}
        error={removeError}
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(undefined)}
      />
    </div>
  );
}
