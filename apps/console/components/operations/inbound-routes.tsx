'use client';
import { useConfirm } from '../ui/dialog';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type Release, type SessionIdentity } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import type { ProviderBinding } from '../../lib/api';
import type { PluginCatalog } from '../plugins/types';
import { InboundRouteForm } from './inbound-route-form';
import { InboundRoutesTable } from './inbound-routes-table';
import {
  EmptyState,
  Field,
  JsonEvidence,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { inboundRoutePath, parseInboundRouteVariables } from './inbound-route-state';

interface RoutePage {
  items: InboundRouteRecord[];
  nextCursor?: string;
}

interface ReleaseOption extends Release {
  agentName: string;
}

const displayTime = (value: string) => new Date(value).toLocaleString();

export function InboundRoutes({ role }: { role: SessionIdentity['role'] }) {
  const confirm = useConfirm();
  const [routes, setRoutes] = useState<InboundRouteRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  const [editing, setEditing] = useState<InboundRouteRecord>();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [variables, setVariables] = useState('{}');
  const [enabled, setEnabled] = useState(true);
  const [carrierPluginId, setCarrierPluginId] = useState('');
  const [carrierBindingId, setCarrierBindingId] = useState('');
  const [carriers, setCarriers] = useState<PluginCatalog['plugins']>([]);
  const [bindings, setBindings] = useState<ProviderBinding[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const loadRoutes = useCallback(async (cursor?: string) => {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { data } = await apiRequest<RoutePage>(`/operations/inbound/routes?${query}`);
    setRoutes((current) => (cursor ? [...current, ...data.items] : data.items));
    setNextCursor(data.nextCursor);
    return data.items;
  }, []);

  const loadReleases = useCallback(async () => {
    const { data } = await apiRequest<unknown>('/agents');
    const agents = items<Record<string, unknown>>(data).map((row) => ({
      id: String(row.id ?? row.agentId),
      name: String(
        (row.config as { name?: unknown } | undefined)?.name ?? row.name ?? row.id ?? row.agentId,
      ),
    }));
    const histories = await Promise.all(
      agents.map(async (agent) => {
        const response = await apiRequest<unknown>(
          `/agents/${encodeURIComponent(agent.id)}/releases`,
        );
        return items<Release>(response.data).map((release) => ({
          ...release,
          agentName: agent.name,
        }));
      }),
    );
    setReleases(histories.flat());
  }, []);

  useEffect(() => {
    Promise.all([loadRoutes(), loadReleases()]).catch((failure) =>
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Inbound routing is not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Inbound routes could not be loaded.',
      ),
    );
  }, [loadReleases, loadRoutes]);
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
        setError(failure instanceof Error ? failure.message : 'Carrier choices unavailable'),
      );
  }, []);

  function resetForm() {
    setEditing(undefined);
    setPhoneNumber('');
    setReleaseId('');
    setVariables('{}');
    setEnabled(true);
    setCarrierPluginId('');
    setCarrierBindingId('');
  }

  function edit(route: InboundRouteRecord) {
    setEditing(route);
    setPhoneNumber(route.phoneNumber);
    setReleaseId(route.releaseId);
    setVariables(JSON.stringify(route.variables, null, 2));
    setEnabled(route.enabled);
    setCarrierPluginId(route.carrierPluginId ?? '');
    setCarrierBindingId(route.carrierBindingId ?? '');
    setError(undefined);
    setNotice(undefined);
  }

  async function recoverFromConflict(action: string) {
    resetForm();
    try {
      await loadRoutes();
    } finally {
      setError(`The route changed before it could be ${action}. The latest list was reloaded.`);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const routeVariables = parseInboundRouteVariables(variables);
      const { data } = await apiRequest<InboundRouteRecord>(inboundRoutePath(phoneNumber), {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: editing?.version ?? null,
          releaseId,
          variables: routeVariables,
          enabled,
          carrierPluginId: carrierPluginId || null,
          carrierBindingId: carrierBindingId || null,
        }),
      });
      setEditing(data);
      setVariables(JSON.stringify(data.variables, null, 2));
      setNotice(`Inbound route ${data.phoneNumber} saved as version ${data.version}.`);
      await loadRoutes();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        await recoverFromConflict('saved');
      } else {
        setError(failure instanceof Error ? failure.message : 'Inbound route could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(route: InboundRouteRecord) {
    if (!(await confirm('Delete inbound route', `Delete inbound route ${route.phoneNumber}?`)))
      return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await apiRequest(`${inboundRoutePath(route.phoneNumber)}?expectedVersion=${route.version}`, {
        method: 'DELETE',
      });
      if (editing?.phoneNumber === route.phoneNumber) resetForm();
      setNotice(`Inbound route ${route.phoneNumber} was deleted.`);
      await loadRoutes();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        await recoverFromConflict('deleted');
      } else {
        setError(
          failure instanceof Error ? failure.message : 'Inbound route could not be deleted.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel labelledBy="inbound-routes-title">
      <PanelHeader
        id="inbound-routes-title"
        title="Inbound number routes"
        badge={<StatusBadge tone="soft">{routes.length} loaded</StatusBadge>}
      />
      <div className="panel-body stack">
        <p className="muted">
          Bind each carrier number to an immutable release. Variables are snapshotted when the
          signed inbound request is admitted; no per-agent environment routing is used.
        </p>
        {role !== 'admin' && (
          <div className="muted">
            Viewer and editor roles can inspect routes but cannot change them.
          </div>
        )}
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="field-error" role="alert">
            {notice}
          </div>
        )}
        <InboundRouteForm
          editing={editing}
          phoneNumber={phoneNumber}
          setPhoneNumber={setPhoneNumber}
          releaseId={releaseId}
          setReleaseId={setReleaseId}
          carrierPluginId={carrierPluginId}
          setCarrierPluginId={setCarrierPluginId}
          carrierBindingId={carrierBindingId}
          setCarrierBindingId={setCarrierBindingId}
          variables={variables}
          setVariables={setVariables}
          enabled={enabled}
          setEnabled={setEnabled}
          releases={releases}
          carriers={carriers}
          bindings={bindings}
          role={role}
          busy={busy}
          onSave={save}
          onCancel={resetForm}
        />
        <InboundRoutesTable
          routes={routes}
          role={role}
          busy={busy}
          onEdit={edit}
          onRemove={remove}
        />
        {nextCursor && (
          <button
            className="button align-start"
            type="button"
            disabled={busy}
            onClick={() => void loadRoutes(nextCursor)}
          >
            Load more routes
          </button>
        )}
      </div>
    </Panel>
  );
}
