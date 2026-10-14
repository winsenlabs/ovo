'use client';
import { useConfirm } from '../ui/dialog';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, type SessionIdentity } from '../../lib/api';
import type { ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { EmptyStateV2, InlineAlert } from '../ui/feedback-v2';
import { Drawer } from '../ui/drawer';
import { Button } from '../ui/button';
import type { ProviderEvaluationAvailability } from './evaluation-provider-state';
import { ProviderAuthorizationsTable } from './provider-authorizations-table';
import { ProviderAuthorizationForm } from './provider-authorization-form';
import { loadAgentReleaseOptions, type ReleaseOption } from './agent-release-options';

interface AuthorizationPage {
  items: ProviderEvaluationAuthorization[];
  nextCursor?: string;
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `provider-authorization-${Date.now()}`;

const AVAILABILITY_LABEL: Record<ProviderEvaluationAvailability, string> = {
  enabled: 'Enabled',
  disabled: 'Installation disabled',
  'admin-only': 'Admin only',
  unknown: 'Unknown',
};

/**
 * Provider evaluation authorizations: a DataTableV2 instead of a raw table, and the create form
 * behind a drawer button instead of sitting above every row by default.
 */
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
  const confirm = useConfirm();
  const [authorizations, setAuthorizations] = useState<ProviderEvaluationAuthorization[]>([]);
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [availability, setAvailability] = useState<ProviderEvaluationAvailability>('unknown');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  useEffect(() => {
    if (role !== 'admin') {
      publish([], 'admin-only');
      return;
    }
    void Promise.all([load(), loadAgentReleaseOptions().then(setReleases)]).catch((failure) =>
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
      setDrawerOpen(false);
      await load();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 503) publish([], 'disabled');
      else
        setError(
          failure instanceof Error ? failure.message : 'Authorization could not be created.',
        );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(authorization: ProviderEvaluationAuthorization) {
    if (
      !(await confirm(
        'Revoke authorization',
        `Revoke provider evaluation authorization ${authorization.id}?`,
      ))
    )
      return;
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
    <SectionCard
      title="Provider evaluation authorizations"
      description="An authorization pins an immutable release, inference binding version, release budget and maximum reservation. It never enables provider evaluations for the installation."
      padding="flush"
      actions={
        <StatusBadgeV2
          tone={availability === 'enabled' ? 'ok' : 'warn'}
          label={
            availability === 'enabled'
              ? `${authorizations.filter((item) => !item.revokedAt).length} active`
              : AVAILABILITY_LABEL[availability]
          }
        />
      }
    >
      {role !== 'admin' && (
        <InlineAlert tone="info">
          Only administrators can inspect or change paid provider-evaluation authorizations. Fixture
          evaluation remains available to editors.
        </InlineAlert>
      )}
      {availability === 'disabled' && (
        <InlineAlert tone="warn">
          Provider evaluations are disabled for this installation. Fixture jobs are unaffected.
        </InlineAlert>
      )}
      {error && <InlineAlert onRetry={() => void load()}>{error}</InlineAlert>}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}
      {role === 'admin' && availability === 'enabled' && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Button variant="primary" type="button" onClick={() => setDrawerOpen(true)}>
            Create authorization
          </Button>
        </div>
      )}
      {role === 'admin' && availability === 'enabled' && authorizations.length === 0 ? (
        <EmptyStateV2 variant="first-run" title="No provider authorizations">
          Provider-backed jobs remain unavailable until an administrator creates an explicit
          immutable release and budget reservation authorization.
        </EmptyStateV2>
      ) : role === 'admin' && authorizations.length ? (
        <ProviderAuthorizationsTable authorizations={authorizations} busy={busy} revoke={revoke} />
      ) : null}
      {nextCursor && (
        <Button type="button" disabled={busy} onClick={() => void load(nextCursor)}>
          Load more authorizations
        </Button>
      )}
      {role === 'admin' && (
        <Drawer
          open={drawerOpen}
          title="Create durable authorization"
          onClose={() => setDrawerOpen(false)}
        >
          <ProviderAuthorizationForm releases={releases} busy={busy} create={create} />
        </Drawer>
      )}
    </SectionCard>
  );
}
