'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError, items, type SessionIdentity } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import type { ProviderBinding } from '../../lib/api';
import type { PluginCatalog } from '../plugins/types';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { Drawer } from '../ui/drawer';
import { ErrorState, InlineAlert } from '../ui/feedback-v2';
import { InboundRouteForm } from './inbound-route-form';
import { InboundRoutesTable, routingLabel } from './inbound-routes-table';
import { useInboundRouteEditor } from './inbound-route-editor';
import { useBoundRouteRelease } from './inbound-route-releases';
import { loadAgentReleaseOptions, type ReleaseOption } from './agent-release-options';
import { InboundPolicy, type Capacity } from './inbound-policy';

interface RoutePage {
  items: InboundRouteRecord[];
  nextCursor?: string;
}

/**
 * The Inbound page: readiness and overflow policy for when no agent can answer, plus the number
 * routes that bind a carrier number to an immutable release. One page — the overflow policy and
 * readiness used to be stranded on Handoffs while the routes table was duplicated on both.
 */
export function InboundRoutes({ role }: { role: SessionIdentity['role'] }) {
  const [routes, setRoutes] = useState<InboundRouteRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  const [carriers, setCarriers] = useState<PluginCatalog['plugins']>([]);
  const [bindings, setBindings] = useState<ProviderBinding[]>([]);
  const [capacity, setCapacity] = useState<Capacity>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();

  const loadRoutes = useCallback(async (cursor?: string) => {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { data } = await apiRequest<RoutePage>(`/operations/inbound/routes?${query}`);
    setRoutes((current) => (cursor ? [...current, ...data.items] : data.items));
    setNextCursor(data.nextCursor);
    return data.items;
  }, []);

  const {
    drawer,
    editing,
    draft,
    setDraft,
    busy,
    error: editorError,
    notice,
    openAdd,
    openEdit,
    closeDrawer,
    save,
    remove,
  } = useInboundRouteEditor({ loadRoutes });

  const listedRelease = Boolean(
    editing && releases.some((release) => release.id === editing.releaseId),
  );
  const bound = useBoundRouteRelease(editing?.releaseId ?? undefined, listedRelease);
  // A routed number is pinned to a routing release, never to one of the listed agent releases.
  const editingRouted = editing ? routingLabel(editing) : undefined;
  const boundRelease = bound?.release;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadRoutes(), loadAgentReleaseOptions().then(setReleases)]);
      setLoadError(undefined);
    } catch (failure) {
      setLoadError(
        failure instanceof ApiError && failure.status === 503
          ? 'Inbound routing is not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Inbound routes could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [loadRoutes]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void Promise.all([
      apiRequest<PluginCatalog>('/plugins?kind=carrier'),
      apiRequest<unknown>('/provider-bindings'),
    ])
      .then(([catalog, rows]) => {
        setCarriers(catalog.data.plugins);
        setBindings(items(rows.data));
      })
      .catch((failure) =>
        setLoadError(failure instanceof Error ? failure.message : 'Carrier choices unavailable'),
      );
  }, []);

  const error = editorError ?? loadError;
  const enabledCount = routes.filter((route) => route.enabled).length;
  const readiness = capacity?.readiness;

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Inbound"
        title="Inbound"
        description="Bind each carrier number to an immutable release. Variables are snapshotted when the signed inbound request is admitted; no per-agent environment routing is used."
        actions={
          <button
            className="button primary"
            type="button"
            onClick={openAdd}
            disabled={role !== 'admin'}
            // The header's flex row can squeeze this button narrower than its own text at small
            // widths, wrapping "Add route" onto two lines; keep it one line and let the row wrap
            // around it instead.
            style={{ whiteSpace: 'nowrap' }}
          >
            Add route
          </button>
        }
        onRefresh={() => void load()}
        refreshing={loading}
      />
      {role !== 'admin' && (
        <InlineAlert tone="info">
          Viewer and editor roles can inspect routes but cannot change them.
        </InlineAlert>
      )}
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {bound?.error && (
        <InlineAlert tone="danger">Bound release unavailable: {bound.error}</InlineAlert>
      )}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}
      {/* A real error with nothing already on screen has nothing honest to show below the
          banner above; once routes are loaded, a later background error still leaves the last
          good list up rather than replacing it with a false "no routes" claim. */}
      {!(error && routes.length === 0 && !loading) && (
        <>
          <KpiStrip>
            <KpiCard
              label="Routes"
              value={loading ? undefined : `${enabledCount}/${routes.length}`}
              loading={loading}
              footnote="enabled of total"
            />
            <KpiCard
              label="Ready workers"
              value={readiness ? readiness.readyWorkers : null}
              footnote={readiness ? `warm floor ${readiness.warmFloor}` : 'No readiness report'}
            />
            <KpiCard
              label="Admission"
              value={readiness ? (readiness.admissionEnabled ? 'Enabled' : 'Disabled') : null}
            />
            <KpiCard
              label="Readiness age"
              value={readiness ? `${Math.round(readiness.ageMs / 1000)}s` : null}
              footnote={readiness?.stale ? 'Stale' : readiness ? 'Fresh' : undefined}
            />
          </KpiStrip>
          <SectionCard
            title="Routes"
            padding="flush"
            description={loading ? undefined : `${routes.length} configured`}
          >
            <InboundRoutesTable
              routes={routes}
              releases={releases}
              carriers={carriers}
              bindings={bindings}
              role={role}
              busy={busy}
              loading={loading}
              onEdit={openEdit}
              onRemove={remove}
            />
            {nextCursor && (
              <div className="ds-card-footer">
                <button
                  className="button small"
                  type="button"
                  disabled={busy}
                  onClick={() => void loadRoutes(nextCursor)}
                >
                  Load more routes
                </button>
              </div>
            )}
          </SectionCard>
        </>
      )}
      <InboundPolicy role={role} onReadiness={setCapacity} />
      <Drawer
        open={drawer !== null}
        onClose={closeDrawer}
        title={editing ? `Edit route v${editing.version}` : 'Add inbound route'}
      >
        {editingRouted && (
          <InlineAlert tone="warn">
            This number is routed through {editingRouted}. Saving an agent release here switches the
            number to that agent, and its calls stop going through the routing point.
          </InlineAlert>
        )}
        <InboundRouteForm
          editing={editing}
          phoneNumber={draft.phoneNumber}
          setPhoneNumber={(value) => setDraft((current) => ({ ...current, phoneNumber: value }))}
          releaseId={draft.releaseId}
          setReleaseId={(value) => setDraft((current) => ({ ...current, releaseId: value }))}
          carrierPluginId={draft.carrierPluginId}
          setCarrierPluginId={(value) =>
            setDraft((current) => ({ ...current, carrierPluginId: value, carrierBindingId: '' }))
          }
          carrierBindingId={draft.carrierBindingId}
          setCarrierBindingId={(value) =>
            setDraft((current) => ({ ...current, carrierBindingId: value }))
          }
          variableRows={draft.variableRows}
          setVariableRows={(rows) => setDraft((current) => ({ ...current, variableRows: rows }))}
          enabled={draft.enabled}
          setEnabled={(value) => setDraft((current) => ({ ...current, enabled: value }))}
          releases={[
            ...(boundRelease && !releases.some((release) => release.id === boundRelease.id)
              ? [boundRelease]
              : []),
            ...releases,
          ]}
          releaseReady={
            !editing ||
            Boolean(editingRouted) ||
            listedRelease ||
            boundRelease?.id === editing.releaseId
          }
          carriers={carriers}
          bindings={bindings}
          role={role}
          busy={busy}
          onSave={save}
          onCancel={closeDrawer}
        />
      </Drawer>
    </div>
  );
}
