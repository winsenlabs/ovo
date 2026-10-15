'use client';
import { useEffect, useState, type FormEvent } from 'react';
import {
  apiRequest,
  items,
  type AgentDraft,
  type Release,
  type SessionIdentity,
} from '../../lib/api';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';
import { InlineAlert } from '../ui/feedback-v2';
import { JsonEditor } from '../forms/json-editor';
import { loadAgents } from '../../lib/pagination';

type LaunchReceipt = {
  callId: string;
  jobId: string;
  campaignId: string;
  contactId: string;
  status: string;
};

const newOperationId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `call-${Date.now()}`;

/** The "Launch live call" drawer, opened from the Calls list PageHeader (admin only). Submission
 * enters durable admission and pre-dial policy checks — an accepted request is not evidence that
 * a carrier call started. */
export function LiveCallForm({
  role,
  onLaunched,
}: {
  role: SessionIdentity['role'];
  onLaunched: () => Promise<void>;
}) {
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const [agentId, setAgentId] = useState('');
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState('');
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [operationId, setOperationId] = useState(newOperationId);
  const [loading, setLoading] = useState(role === 'admin');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string }>();

  useEffect(() => {
    if (role !== 'admin') return;
    loadAgents<AgentDraft>()
      .then((next) => {
        setAgents(next);
        setAgentId((current) => current || next[0]?.id || '');
      })
      .catch((error) =>
        setMessage({
          tone: 'danger',
          text: error instanceof Error ? error.message : 'Agents could not be loaded.',
        }),
      )
      .finally(() => setLoading(false));
  }, [role]);

  useEffect(() => {
    if (!agentId || role !== 'admin') {
      setReleases([]);
      setReleaseId('');
      return;
    }
    apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`)
      .then(({ data }) => {
        const next = items<Release>(data);
        setReleases(next);
        setReleaseId(next[0]?.id ?? '');
      })
      .catch((error) => {
        setReleases([]);
        setReleaseId('');
        setMessage({
          tone: 'danger',
          text: error instanceof Error ? error.message : 'Releases could not be loaded.',
        });
      });
  }, [agentId, role]);

  async function launch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setSubmitting(true);
    setMessage(undefined);
    try {
      const { data } = await apiRequest<LaunchReceipt>('/calls', {
        method: 'POST',
        body: JSON.stringify({
          operationId,
          releaseId,
          fromNumber: values.get('fromNumber'),
          to: values.get('to'),
          variables,
        }),
      });
      setMessage({
        tone: 'info',
        text: `Call ${data.callId} was accepted for durable admission. This does not assert that the carrier dialed.`,
      });
      setOperationId(newOperationId());
      await onLaunched();
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'Live call admission failed.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (role !== 'admin') return null;
  return (
    <form className="ds-stack" onSubmit={launch}>
      <p className="muted">
        Submission enters durable admission and pre-dial policy checks. An accepted request is not
        evidence that a carrier call started.
      </p>
      <FormField id="live-agent" label="Agent" required>
        {({ id }) => (
          <Select
            id={id}
            value={agentId}
            onChange={setAgentId}
            options={agents.map((agent) => ({ value: agent.id, label: agent.config.name }))}
          />
        )}
      </FormField>
      <FormField id="live-release" label="Immutable release" required>
        {({ id }) => (
          <Select
            id={id}
            value={releaseId}
            onChange={setReleaseId}
            options={releases.map((release) => ({ value: release.id, label: release.id }))}
          />
        )}
      </FormField>
      <FormField id="live-from" label="Permitted from number" required>
        {(control) => <input {...control} name="fromNumber" type="tel" placeholder="+91…" />}
      </FormField>
      <FormField id="live-to" label="Recipient" required>
        {(control) => <input {...control} name="to" type="tel" placeholder="+91…" />}
      </FormField>
      <FormField id="live-operation" label="Operation ID" required>
        {(control) => (
          <input
            {...control}
            className="mono"
            value={operationId}
            onChange={(event) => setOperationId(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        id="live-call-variables"
        label="Release variables"
        help="Must satisfy the immutable release variable schema."
      >
        {() => (
          <JsonEditor
            id="live-call-variables"
            value={variables}
            onValid={(value) => setVariables(value as Record<string, unknown>)}
          />
        )}
      </FormField>
      {releases.length === 0 && !loading && (
        <p className="muted">Publish an immutable release before starting a live call.</p>
      )}
      <button type="submit" className="button primary" disabled={submitting || !releaseId}>
        {submitting ? 'Submitting admission…' : 'Submit live call'}
      </button>
      {message && (
        <InlineAlert tone={message.tone === 'info' ? 'info' : 'danger'}>{message.text}</InlineAlert>
      )}
    </form>
  );
}
