'use client';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type CallSummary, type SessionIdentity } from '../../lib/api';
import type { HandoffRecord } from '../../lib/operator-api';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { DataTableV2 } from '../ui/data-table-v2';
import { Drawer } from '../ui/drawer';
import { EmptyStateV2, ErrorState } from '../ui/feedback-v2';
import { liveCallColumns, sessionHandoffColumns } from './handoffs-view-columns';
import { HandoffRequestPanel } from './handoff-request-panel';
import { loadAgentReleaseOptions, type ReleaseOption } from './agent-release-options';

/**
 * Handoffs: live calls that can be handed to a human or another queue, and the handoffs this
 * session has requested or looked up. The API has no handoff listing endpoint, so that list is
 * honestly scoped to "what this session knows about", not "every handoff ever requested".
 */
export function HandoffsView({ role }: { role: SessionIdentity['role'] }) {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [callsLoading, setCallsLoading] = useState(true);
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [targetKind, setTargetKind] = useState<'phone' | 'queue'>('phone');
  const [fallbackKind, setFallbackKind] = useState<'resume' | 'end' | 'human'>('resume');
  const [lookupId, setLookupId] = useState('');
  const [requesting, setRequesting] = useState<CallSummary>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const loadCalls = useCallback(async () => {
    setCallsLoading(true);
    try {
      const [callsResponse, releaseOptions] = await Promise.all([
        apiRequest<unknown>('/calls'),
        // Resolving agent names for the Agent column is best-effort: a release lookup failure
        // should not take down the live-calls table itself.
        loadAgentReleaseOptions().catch(() => []),
      ]);
      setCalls(
        items<CallSummary>(callsResponse.data).filter(
          (call) => call.kind === 'live' && !call.completedAt,
        ),
      );
      setReleases(releaseOptions);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Live calls unavailable.');
    } finally {
      setCallsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  const upsert = (record: HandoffRecord) =>
    setHandoffs((current) => [record, ...current.filter((item) => item.id !== record.id)]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    const fallback =
      fallbackKind === 'human'
        ? {
            kind: fallbackKind,
            target: values.get('fallbackTarget'),
            message: values.get('fallbackMessage'),
          }
        : { kind: fallbackKind, message: values.get('fallbackMessage') };
    try {
      upsert(
        (
          await apiRequest<HandoffRecord>('/operations/handoffs', {
            method: 'POST',
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              callId: values.get('callId'),
              target: { kind: targetKind, value: values.get('target') },
              fallback,
              confirmationRequired: values.get('confirmationRequired') === 'on',
            }),
          })
        ).data,
      );
      setRequesting(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Handoff operations are not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Handoff could not be requested.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function lookup(id = lookupId) {
    if (!id) return;
    setBusy(true);
    setError(undefined);
    try {
      upsert((await apiRequest<HandoffRecord>(`/operations/handoffs/${id}`)).data);
      setLookupId('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Handoff not found.');
    } finally {
      setBusy(false);
    }
  }
  async function confirmHandoff(record: HandoffRecord, accepted: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      upsert(
        (
          await apiRequest<HandoffRecord>(`/operations/handoffs/${record.id}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ accepted }),
          })
        ).data,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Confirmation failed.');
    } finally {
      setBusy(false);
    }
  }

  const callColumns = useMemo(
    () => liveCallColumns({ role, releases, onRequest: setRequesting }),
    [role, releases],
  );
  const handoffColumns = useMemo(
    () =>
      sessionHandoffColumns({
        role,
        busy,
        onConfirm: (record, accepted) => void confirmHandoff(record, accepted),
        onRefresh: (id) => void lookup(id),
      }),
    [role, busy],
  );

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Calls"
        title="Handoffs"
        description="A handoff is confirmed only by a provider receipt; unknown outcomes remain unknown and are never blindly retried."
        onRefresh={() => void loadCalls()}
        refreshing={callsLoading}
      />
      {error && <ErrorState message={error} onRetry={() => void loadCalls()} />}
      <KpiStrip>
        <KpiCard
          label="Live calls"
          value={callsLoading ? undefined : calls.length}
          loading={callsLoading}
        />
        <KpiCard label="Handoffs this session" value={handoffs.length} />
        <KpiCard
          label="Awaiting confirmation"
          value={handoffs.filter((record) => record.status === 'awaiting_confirmation').length}
        />
      </KpiStrip>
      {/* A real error with no calls already on screen has nothing honest to show; a background
          error on a later refresh still leaves the last good list up instead of claiming there
          is no live call at all. */}
      {!(error && calls.length === 0 && !callsLoading) && (
        <SectionCard
          title="Live calls now"
          description="Only verified carrier-bound live calls can be handed off; simulation calls cannot."
          padding="flush"
        >
          <DataTableV2
            // Loading must get its own key too, not just empty vs. populated: see data-table-v2.tsx
            // and inbound-routes-table.tsx for why reusing the key across that transition crashes.
            key={callsLoading ? 'loading' : calls.length === 0 ? 'empty' : 'data'}
            label="Live calls"
            rows={calls}
            columns={callColumns}
            rowKey={(call) => call.id}
            loading={callsLoading}
            empty={
              <EmptyStateV2 title="No active live calls">
                No verified live call is in progress right now.
              </EmptyStateV2>
            }
          />
        </SectionCard>
      )}
      <SectionCard
        title="Session handoffs"
        description="Requests you make or look up appear here. The API does not expose a broad handoff listing endpoint."
        padding="flush"
        actions={
          <div className="ds-filter-row">
            <input
              aria-label="Look up handoff by ID"
              placeholder="Handoff ID"
              value={lookupId}
              onChange={(event) => setLookupId(event.target.value)}
              // A bare flex child shrinks to a sliver next to the "Load" button at narrow
              // widths, truncating anything typed; give it room to be the thing that wraps.
              style={{ flex: '1 1 160px', minWidth: 0 }}
            />
            <button
              className="button small"
              type="button"
              disabled={!lookupId || busy}
              onClick={() => void lookup()}
            >
              Load
            </button>
          </div>
        }
      >
        <DataTableV2
          key={handoffs.length === 0 ? 'empty' : 'data'}
          label="Session handoffs"
          rows={handoffs}
          columns={handoffColumns}
          rowKey={(record) => record.id}
          empty={
            <EmptyStateV2 title="No handoffs yet">
              Request a handoff from a live call above, or load one by its persisted ID.
            </EmptyStateV2>
          }
        />
      </SectionCard>
      <Drawer
        open={requesting !== undefined}
        onClose={() => setRequesting(undefined)}
        title="Request handoff"
      >
        {requesting && (
          <HandoffRequestPanel
            call={requesting}
            targetKind={targetKind}
            setTargetKind={setTargetKind}
            fallbackKind={fallbackKind}
            setFallbackKind={setFallbackKind}
            role={role}
            busy={busy}
            create={create}
            onCancel={() => setRequesting(undefined)}
          />
        )}
      </Drawer>
    </div>
  );
}
