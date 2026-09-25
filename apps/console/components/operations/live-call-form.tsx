'use client';
import { useEffect, useState, type FormEvent } from 'react';
import {
  apiRequest,
  items,
  type AgentDraft,
  type Release,
  type SessionIdentity,
} from '../../lib/api';
import { Field, Panel, PanelHeader, StatusBadge } from '../primitives';
import { JsonEditor } from '../forms/json-editor';

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
  const [message, setMessage] = useState<{ tone: 'neutral' | 'danger'; text: string }>();

  useEffect(() => {
    if (role !== 'admin') return;
    apiRequest<unknown>('/agents')
      .then(({ data }) => {
        const next = items<AgentDraft>(data);
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
        tone: 'neutral',
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
    <Panel labelledBy="live-call-title">
      <PanelHeader
        id="live-call-title"
        title="Start live call"
        badge={<StatusBadge tone="warning">Carrier path</StatusBadge>}
      />
      <form className="panel-body stack" onSubmit={launch}>
        <div className="muted">
          Submission enters durable admission and pre-dial policy checks. An accepted request is not
          evidence that a carrier call started.
        </div>
        <div className="form-grid">
          <Field label="Agent" htmlFor="live-agent">
            <select
              id="live-agent"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={loading}
              required
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.config.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Immutable release" htmlFor="live-release">
            <select
              id="live-release"
              value={releaseId}
              onChange={(event) => setReleaseId(event.target.value)}
              required
            >
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Permitted from number" htmlFor="live-from">
            <input id="live-from" name="fromNumber" type="tel" placeholder="+91…" required />
          </Field>
          <Field label="Recipient" htmlFor="live-to">
            <input id="live-to" name="to" type="tel" placeholder="+91…" required />
          </Field>
          <Field label="Operation ID" htmlFor="live-operation">
            <input
              id="live-operation"
              className="mono"
              value={operationId}
              onChange={(event) => setOperationId(event.target.value)}
              required
            />
          </Field>
        </div>
        <Field
          label="Release variables"
          htmlFor="live-call-variables"
          help="Must satisfy the immutable release variable schema."
        >
          <JsonEditor
            id="live-call-variables"
            value={variables}
            onValid={(value) => setVariables(value as Record<string, unknown>)}
          />
        </Field>
        {releases.length === 0 && !loading && (
          <div className="muted">Publish an immutable release before starting a live call.</div>
        )}
        <button className="button primary align-start" disabled={submitting || !releaseId}>
          {submitting ? 'Submitting admission…' : 'Submit live call'}
        </button>
        {message && (
          <div className="field-error" role="alert">
            {message.text}
          </div>
        )}
      </form>
    </Panel>
  );
}
