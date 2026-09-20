'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type Release, type SessionIdentity } from '../../lib/api';
import type { ProviderEvaluationAuthorization } from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import type { ProviderEvaluationAvailability } from './evaluation-provider-state';

interface ReleaseOption extends Release {
  agentName: string;
}

interface AuthorizationPage {
  items: ProviderEvaluationAuthorization[];
  nextCursor?: string;
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `provider-authorization-${Date.now()}`;

export function EvaluationProviderAuthorizations({
  role,
  onChange,
}: {
  role: SessionIdentity['role'];
  onChange(
    authorizations: ProviderEvaluationAuthorization[],
    availability: ProviderEvaluationAvailability,
  ): void;
}) {
  const [authorizations, setAuthorizations] = useState<ProviderEvaluationAuthorization[]>([]);
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [availability, setAvailability] = useState<ProviderEvaluationAvailability>('unknown');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const publish = useCallback(
    (next: ProviderEvaluationAuthorization[], status: ProviderEvaluationAvailability) => {
      setAuthorizations(next);
      setAvailability(status);
      onChange(next, status);
    },
    [onChange],
  );

  const load = useCallback(
    async (cursor?: string) => {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      try {
        const { data } = await apiRequest<AuthorizationPage>(
          `/evaluation-provider-authorizations?${query}`,
        );
        const next = cursor ? [...authorizations, ...data.items] : data.items;
        setNextCursor(data.nextCursor);
        publish(next, 'enabled');
        setError(undefined);
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 503) {
          publish([], 'disabled');
          setError(undefined);
        } else {
          setAvailability('unknown');
          onChange([], 'unknown');
          setError(
            failure instanceof Error
              ? failure.message
              : 'Provider evaluation authorizations could not be loaded.',
          );
        }
      }
    },
    [authorizations, onChange, publish],
  );

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
    if (role !== 'admin') {
      publish([], 'admin-only');
      return;
    }
    void Promise.all([load(), loadReleases()]).catch((failure) =>
      setError(
        failure instanceof Error ? failure.message : 'Authorization dependencies could not load.',
      ),
    );
    // Initial admin load is intentionally stable; later pages and mutations call load explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { data } = await apiRequest<ProviderEvaluationAuthorization>(
        '/evaluation-provider-authorizations',
        {
          method: 'POST',
          body: JSON.stringify({
            releaseId: values.get('releaseId'),
            maximumReservationPaise: values.get('maximumReservationPaise'),
            idempotencyKey,
          }),
        },
      );
      setNotice(`Authorization ${data.id} created for immutable release ${data.releaseId}.`);
      setIdempotencyKey(newKey());
      form.reset();
      await load();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 503) {
        publish([], 'disabled');
      } else {
        setError(
          failure instanceof Error ? failure.message : 'Authorization could not be created.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(authorization: ProviderEvaluationAuthorization) {
    if (!window.confirm(`Revoke provider evaluation authorization ${authorization.id}?`)) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await apiRequest(
        `/evaluation-provider-authorizations/${encodeURIComponent(authorization.id)}/revoke`,
        { method: 'POST' },
      );
      setNotice(`Authorization ${authorization.id} was revoked. New runs cannot use it.`);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Authorization could not be revoked.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel labelledBy="provider-evaluation-authorizations-title">
      <PanelHeader
        id="provider-evaluation-authorizations-title"
        title="Provider evaluation authorizations"
        badge={
          <StatusBadge tone={availability === 'enabled' ? 'good' : 'warning'}>
            {availability === 'enabled'
              ? `${authorizations.filter((item) => !item.revokedAt).length} active`
              : availability === 'disabled'
                ? 'Installation disabled'
                : availability === 'admin-only'
                  ? 'Admin only'
                  : 'Unknown'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <p className="muted">
          An authorization pins an immutable release, inference binding version, release budget, and
          maximum reservation. It never enables provider evaluations for the installation.
        </p>
        {role !== 'admin' && (
          <Notice tone="neutral">
            Only administrators can inspect or change paid provider-evaluation authorizations.
            Fixture evaluation remains available to editors.
          </Notice>
        )}
        {availability === 'disabled' && (
          <Notice tone="warning">
            Provider evaluations are disabled for this installation. Set
            OVO_PROVIDER_EVALUATIONS_ENABLED on the server and restart intentionally; the browser
            cannot change this flag. Fixture jobs are unaffected.
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
        {role === 'admin' && availability === 'enabled' && (
          <form className="nested-card stack" onSubmit={create}>
            <strong>Create durable authorization</strong>
            <div className="form-grid">
              <Field label="Immutable release" htmlFor="provider-authorization-release">
                <select id="provider-authorization-release" name="releaseId" required>
                  <option value="">Select immutable release</option>
                  {releases.map((release) => (
                    <option key={release.id} value={release.id}>
                      {release.agentName} · {release.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Maximum reservation (paise)"
                htmlFor="provider-authorization-maximum"
                help="The immutable release reservation must remain at or below this positive cap."
              >
                <input
                  id="provider-authorization-maximum"
                  name="maximumReservationPaise"
                  inputMode="numeric"
                  pattern="[1-9][0-9]{0,59}"
                  placeholder="5000"
                  required
                />
              </Field>
            </div>
            <button className="button primary align-start" disabled={busy || releases.length === 0}>
              {busy ? 'Creating…' : 'Create authorization'}
            </button>
          </form>
        )}
        {role === 'admin' && availability === 'enabled' && !authorizations.length ? (
          <EmptyState title="No provider authorizations">
            Provider-backed jobs remain unavailable until an administrator creates an explicit
            immutable release and budget reservation authorization.
          </EmptyState>
        ) : role === 'admin' && authorizations.length ? (
          <ResponsiveTable label="Provider evaluation authorizations">
            <thead>
              <tr>
                <th>Immutable release</th>
                <th>Provider binding</th>
                <th>Budget authorization</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {authorizations.map((authorization) => (
                <tr key={authorization.id}>
                  <td>
                    <span className="mono">{authorization.releaseId}</span>
                    <small>{authorization.releaseFingerprint}</small>
                  </td>
                  <td>
                    {authorization.provider} · {authorization.modelId}
                    <small className="mono">{authorization.bindingVersion}</small>
                  </td>
                  <td>
                    <span className="mono">{authorization.budgetId}</span>
                    <small className="mono">Authorization {authorization.id}</small>
                    <small>Maximum {authorization.maximumReservationPaise} paise</small>
                  </td>
                  <td>
                    <StatusBadge tone={authorization.revokedAt ? 'warning' : 'good'}>
                      {authorization.revokedAt ? 'Revoked' : 'Active'}
                    </StatusBadge>
                    <small>{new Date(authorization.createdAt).toLocaleString()}</small>
                  </td>
                  <td>
                    <button
                      className="button small danger"
                      type="button"
                      disabled={busy || Boolean(authorization.revokedAt)}
                      onClick={() => void revoke(authorization)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        ) : null}
        {nextCursor && (
          <button
            className="button align-start"
            type="button"
            disabled={busy}
            onClick={() => void load(nextCursor)}
          >
            Load more authorizations
          </button>
        )}
      </div>
    </Panel>
  );
}
