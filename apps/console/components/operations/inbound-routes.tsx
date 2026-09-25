'use client';
import { useConfirm } from '../ui/dialog';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type Release, type SessionIdentity } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import type { ProviderBinding } from '../../lib/api';
import type { PluginCatalog } from '../plugins/types';
import {
  EmptyState,
  Field,
  JsonEvidence,
  Notice,
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
    void Promise.all([apiRequest<PluginCatalog>('/plugins?kind=carrier'), apiRequest<unknown>('/provider-bindings')])
      .then(([catalog, rows]) => { setCarriers(catalog.data.plugins); setBindings(items(rows.data)); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'Carrier choices unavailable'));
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
    if (!(await confirm('Delete inbound route', `Delete inbound route ${route.phoneNumber}?`))) return;
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
          <Notice tone="neutral">
            Viewer and editor roles can inspect routes but cannot change them.
          </Notice>
        )}
        {error && (
          <Notice tone="danger" live>
            {error}
          </Notice>
        )}
        {notice && (
          <Notice tone="neutral" live>
            {notice}
          </Notice>
        )}
        <form className="nested-card stack" onSubmit={save}>
          <strong>{editing ? `Edit route v${editing.version}` : 'Add inbound route'}</strong>
          <div className="form-grid">
            <Field label="Inbound phone number" htmlFor="inbound-route-number">
              <input
                id="inbound-route-number"
                type="tel"
                placeholder="+91…"
                pattern="\+[1-9][0-9]{7,14}"
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                disabled={role !== 'admin' || Boolean(editing)}
                required
              />
            </Field>
            <Field label="Immutable release" htmlFor="inbound-route-release">
              <select
                id="inbound-route-release"
                value={releaseId}
                onChange={(event) => setReleaseId(event.target.value)}
                disabled={role !== 'admin'}
                required
              >
                <option value="">Select immutable release</option>
                {releases.map((release) => (
                  <option key={release.id} value={release.id}>
                    {release.agentName} · {release.id} · {displayTime(release.createdAt)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Carrier plugin" htmlFor="inbound-route-carrier">
              <select id="inbound-route-carrier" value={carrierPluginId} disabled={role !== 'admin'} onChange={event => { setCarrierPluginId(event.target.value); setCarrierBindingId(''); }}>
                <option value="">Environment carrier</option>
                {carriers.map(carrier => <option key={carrier.id} value={carrier.id}>{carrier.ui?.label ?? carrier.id}</option>)}
              </select>
            </Field>
            <Field label="Carrier binding" htmlFor="inbound-route-carrier-binding">
              <select id="inbound-route-carrier-binding" value={carrierBindingId} disabled={role !== 'admin'} onChange={event => setCarrierBindingId(event.target.value)}>
                <option value="">Environment binding</option>
                {bindings.filter(binding => binding.pluginId === carrierPluginId).map(binding => <option key={binding.id} value={binding.id}>{binding.label}</option>)}
              </select>
            </Field>
            <Field
              label="Release variables JSON"
              htmlFor="inbound-route-variables"
              help="Use a JSON object whose values are strings. The API validates required variables against the selected release."
            >
              <textarea
                id="inbound-route-variables"
                className="code-input compact"
                value={variables}
                onChange={(event) => setVariables(event.target.value)}
                disabled={role !== 'admin'}
                required
              />
            </Field>
            <label className="checkbox-row" htmlFor="inbound-route-enabled">
              <input
                id="inbound-route-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={role !== 'admin'}
              />
              <span>Accept inbound admission on this route</span>
            </label>
          </div>
          <div className="button-row">
            <button className="button primary" disabled={role !== 'admin' || busy}>
              {busy ? 'Saving…' : editing ? 'Save route version' : 'Create route'}
            </button>
            {editing && (
              <button className="button" type="button" onClick={resetForm} disabled={busy}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
        {!routes.length ? (
          <EmptyState title="No inbound number routes">
            An administrator must bind a carrier number to an immutable release before inbound
            admission can resolve an agent configuration.
          </EmptyState>
        ) : (
          <ResponsiveTable label="Configured inbound number routes">
            <thead>
              <tr>
                <th>Phone number</th>
                <th>Immutable release</th>
                <th>Carrier</th>
                <th>State</th>
                <th>Version</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => (
                <tr key={route.phoneNumber}>
                  <td className="mono">{route.phoneNumber}</td>
                  <td>
                    <span className="mono">{route.releaseId}</span>
                    <JsonEvidence label="Snapshotted variables" value={route.variables} />
                  </td>
                  <td>{route.carrierPluginId ?? 'Environment'}<small>{route.carrierBindingId ?? 'Environment binding'}</small></td>
                  <td>
                    <StatusBadge tone={route.enabled ? 'good' : 'warning'}>
                      {route.enabled ? 'Enabled' : 'Disabled'}
                    </StatusBadge>
                  </td>
                  <td>
                    v{route.version}
                    <small>{displayTime(route.updatedAt)}</small>
                  </td>
                  <td>
                    <div className="button-row">
                      <button className="button small" type="button" onClick={() => edit(route)}>
                        Edit
                      </button>
                      <button
                        className="button small danger"
                        type="button"
                        onClick={() => void remove(route)}
                        disabled={role !== 'admin' || busy}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
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
