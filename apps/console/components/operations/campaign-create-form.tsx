'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, items, type Release } from '../../lib/api';
import type { CampaignRecord } from '../../lib/operator-api';
import { useFormAction } from '../forms/use-form-action';
import { useOperationId } from '../../lib/ids';
import { FormField } from '../ui/form-field';
import { Stepper, type StepState } from '../ui/stepper';
import { ErrorState } from '../ui/feedback-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { formatDateTime } from '../../lib/format';
import { CampaignContactImport, type CompliancePreview } from './campaign-contact-import';
import { callingWindowBody, campaignComplianceBody } from './campaign-calling-window';
import { CampaignScheduleFields } from './campaign-schedule-fields';
import { loadAgentChoices } from './agent-release-options';

export function CampaignCreateForm({
  onCreated,
}: {
  onCreated: (campaign: CampaignRecord) => void;
}) {
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = useState('');
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState('');
  const [preview, setPreview] = useState<CompliancePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const formAction = useFormAction();
  const operationId = useOperationId();
  useEffect(() => {
    loadAgentChoices()
      .then((rows) => {
        setAgents(rows);
        setAgentId(rows[0]?.id ?? '');
      })
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Agents unavailable.'),
      );
  }, []);
  // A preview validated against another release's variables no longer holds.
  useEffect(() => setPreview(undefined), [releaseId]);
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
      await formAction(event, async (values) => {
        const { data } = await apiRequest<CampaignRecord>('/operations/campaigns', {
          method: 'POST',
          body: JSON.stringify({
            operationId: operationId.current(),
            name: values.get('name'),
            releaseId,
            fromNumber: values.get('fromNumber'),
            schedule: {
              localDateTime: values.get('localDateTime'),
              timezone: values.get('timezone'),
            },
            perNumberAttemptLimit: Number(values.get('perNumberAttemptLimit')),
            maxAttemptsTotal: Number(values.get('maxAttemptsTotal')),
            maxAttemptsPerLocalDay: Number(values.get('maxAttemptsPerLocalDay')),
            maxConcurrency: Number(values.get('maxConcurrency')),
            activeCallPolicy: values.get('activeCallPolicy'),
            ...callingWindowBody(values),
            ...campaignComplianceBody(values),
            contacts: preview.rows,
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
  const step1Done = Boolean(releaseId);
  const step2Done = Boolean(preview?.rows.length && !preview.errors.length);
  const steps: { label: string; state: StepState }[] = [
    { label: 'Agent & release', state: step1Done ? 'done' : 'current' },
    { label: 'Contacts', state: !step1Done ? 'upcoming' : step2Done ? 'done' : 'current' },
    { label: 'Schedule & limits', state: step2Done ? 'current' : 'upcoming' },
  ];
  return (
    <form className="stack" onSubmit={create}>
      <Stepper steps={steps} />
      {error && <ErrorState message={error} />}
      <fieldset className="stack">
        <legend className="eyebrow">1 · Immutable release</legend>
        <div className="form-grid">
          <FormField id="campaign-agent" label="Agent">
            {(control) => (
              <select
                {...control}
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
            )}
          </FormField>
          <FormField id="campaign-release" label="Release">
            {(control) => (
              <select
                {...control}
                value={releaseId}
                onChange={(event) => setReleaseId(event.target.value)}
                required
              >
                <option value="">Select immutable release</option>
                {releases.map((release, index) => (
                  <option key={release.id} value={release.id}>
                    Release {releases.length - index} of {releases.length} ·{' '}
                    {formatDateTime(release.createdAt)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        {agentId && !releases.length && (
          <EmptyStateV2 title="No immutable release">
            This agent has no immutable release. Publish one before creating a campaign.
          </EmptyStateV2>
        )}
      </fieldset>
      <fieldset className="stack" disabled={!step1Done}>
        <legend className="eyebrow">2 · Contacts</legend>
        <CampaignContactImport preview={preview} onPreview={setPreview} releaseId={releaseId} />
      </fieldset>
      <fieldset className="stack" disabled={!step2Done}>
        <legend className="eyebrow">3 · Schedule and limits</legend>
        {!preview && (
          <EmptyStateV2 title="Validate contacts first">
            Campaign controls unlock after the server returns a clean preview.
          </EmptyStateV2>
        )}
        <CampaignScheduleFields disabled={!preview} defaultAttempts={preview?.rows.length || 1} />
        <div className="button-row">
          <button
            className="button primary"
            disabled={busy || !preview?.rows.length || Boolean(preview.errors.length) || !releaseId}
          >
            {busy ? 'Creating…' : 'Create scheduled campaign'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
