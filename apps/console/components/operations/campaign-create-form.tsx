'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, items, type Release } from '../../lib/api';
import type { CampaignPreview, CampaignRecord } from '../../lib/operator-api';
import { useFormAction } from '../forms/use-form-action';
import { useOperationId } from '../../lib/ids';
import { EmptyState, Field, Notice } from '../primitives';
import { CampaignContactImport } from './campaign-contact-import';

export function CampaignCreateForm({
  onCreated,
}: {
  onCreated: (campaign: CampaignRecord) => void;
}) {
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = useState('');
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState('');
  const [preview, setPreview] = useState<CampaignPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const formAction = useFormAction();
  const operationId = useOperationId();
  useEffect(() => {
    apiRequest<unknown>('/agents')
      .then(({ data }) => {
        const rows = items<Record<string, unknown>>(data).map((row) => ({
          id: String(row.id ?? row.agentId),
          name: String(
            (row.config as { name?: unknown } | undefined)?.name ??
              row.name ??
              row.id ??
              row.agentId,
          ),
        }));
        setAgents(rows);
        setAgentId(rows[0]?.id ?? '');
      })
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Agents unavailable.'),
      );
  }, []);
  useEffect(() => {
    setReleases([]);
    setReleaseId('');
    if (!agentId) return;
    apiRequest<unknown>(`/agents/${agentId}/releases`)
      .then(({ data }) => {
        const rows = items<Release>(data);
        setReleases(rows);
        setReleaseId(rows[0]?.id ?? '');
      })
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Releases unavailable.'),
      );
  }, [agentId]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview?.rows.length || preview.errors.length) return;
    setBusy(true);
    setError(undefined);
    try {
      await formAction(event, async values => {
        const { data } = await apiRequest<CampaignRecord>('/operations/campaigns', {
          method: 'POST',
          body: JSON.stringify({
            operationId: operationId.current(),
            name: values.get('name'), releaseId, fromNumber: values.get('fromNumber'),
            schedule: { localDateTime: values.get('localDateTime'), timezone: values.get('timezone') },
            perNumberAttemptLimit: Number(values.get('perNumberAttemptLimit')),
            maxAttemptsTotal: Number(values.get('maxAttemptsTotal')),
            maxAttemptsPerLocalDay: Number(values.get('maxAttemptsPerLocalDay')),
            maxConcurrency: Number(values.get('maxConcurrency')),
            activeCallPolicy: values.get('activeCallPolicy'), contacts: preview.rows,
          }),
        });
        onCreated(data);
        setPreview(undefined);
        operationId.succeeded();
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Campaign could not be created.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack" onSubmit={create}>
      {error && (
        <Notice tone="danger" live>
          {error}
        </Notice>
      )}
      <fieldset className="nested-card">
        <legend>1 · Immutable release</legend>
        <div className="form-grid">
          <Field label="Agent" htmlFor="campaign-agent">
            <select
              id="campaign-agent"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              required
            >
              <option value="">Select agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Release" htmlFor="campaign-release">
            <select
              id="campaign-release"
              value={releaseId}
              onChange={(event) => setReleaseId(event.target.value)}
              required
            >
              <option value="">Select immutable release</option>
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.id} · {new Date(release.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {agentId && !releases.length && (
          <Notice tone="warning">
            This agent has no immutable release. Publish one before creating a campaign.
          </Notice>
        )}
      </fieldset>
      <CampaignContactImport preview={preview} onPreview={setPreview} />
      <fieldset className="nested-card">
        <legend>3 · Schedule and limits</legend>
        {!preview && (
          <EmptyState title="Validate contacts first">
            Campaign controls unlock after the server returns a clean preview.
          </EmptyState>
        )}
        <div className="form-grid">
          <Field label="Campaign name" htmlFor="campaign-name">
            <input id="campaign-name" name="name" required disabled={!preview} />
          </Field>
          <Field label="Permitted caller number" htmlFor="campaign-from">
            <input
              id="campaign-from"
              name="fromNumber"
              type="tel"
              placeholder="+91…"
              required
              disabled={!preview}
            />
          </Field>
          <Field label="Local schedule" htmlFor="campaign-at">
            <input
              id="campaign-at"
              name="localDateTime"
              type="datetime-local"
              required
              disabled={!preview}
            />
          </Field>
          <Field label="IANA timezone" htmlFor="campaign-timezone">
            <input
              id="campaign-timezone"
              name="timezone"
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              required
              disabled={!preview}
            />
          </Field>
          <Field label="Attempts per number" htmlFor="campaign-per-number">
            <input
              id="campaign-per-number"
              name="perNumberAttemptLimit"
              type="number"
              min={1}
              max={100}
              defaultValue={1}
              required
              disabled={!preview}
            />
          </Field>
          <Field label="Maximum total attempts" htmlFor="campaign-total">
            <input
              id="campaign-total"
              name="maxAttemptsTotal"
              type="number"
              min={1}
              defaultValue={preview?.rows.length || 1}
              required
              disabled={!preview}
            />
          </Field>
          <Field label="Maximum attempts per local day" htmlFor="campaign-daily">
            <input
              id="campaign-daily"
              name="maxAttemptsPerLocalDay"
              type="number"
              min={1}
              defaultValue={preview?.rows.length || 1}
              required
              disabled={!preview}
            />
          </Field>
          <Field label="Maximum concurrent calls" htmlFor="campaign-concurrency">
            <input id="campaign-concurrency" name="maxConcurrency" type="number" min={1} max={1000} defaultValue={1} required disabled={!preview} />
          </Field>
          <Field label="Active calls on cancel" htmlFor="campaign-active-policy">
            <select id="campaign-active-policy" name="activeCallPolicy" disabled={!preview}>
              <option value="continue">Allow active calls to continue</option>
              <option value="request_end">Request active calls to end</option>
            </select>
          </Field>
        </div>
        <button
          className="button primary"
          disabled={busy || !preview?.rows.length || Boolean(preview.errors.length) || !releaseId}
        >
          {busy ? 'Creating…' : 'Create scheduled campaign'}
        </button>
      </fieldset>
    </form>
  );
}
