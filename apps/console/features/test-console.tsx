'use client';
import { useEffect, useState } from 'react';
import { ApiError, apiRequest, ifMatch, normalizeDraft, type AgentDraft } from '../lib/api';
import { useEventStream } from '../lib/data/use-event-stream';
import type { PluginCatalog } from '../components/plugins/types';
import { PageHeader } from '../components/ui/layout';
import { EmptyState, Callout, StatusBadge } from '../components/ui/feedback';

type FixtureEvent = {
  eventId?: string;
  kind?: string;
  type?: string;
  stage?: string;
  text?: string;
  phase?: string;
  speaker?: string;
  costPaise?: string;
  payload?: Record<string, unknown>;
};
function field(event: FixtureEvent, key: keyof FixtureEvent): string | undefined {
  const value = event[key] ?? event.payload?.[key];
  return typeof value === 'string' ? value : undefined;
}
function transcriptPhase(event: FixtureEvent) {
  const phase = field(event, 'phase') ?? event.kind ?? event.type ?? '';
  return /played/i.test(phase)
    ? 'played'
    : /generated/i.test(phase)
      ? 'generated'
      : /interim/i.test(phase)
        ? 'interim'
        : 'final';
}
export function TestConsoleFeature({ agentId }: { agentId: string }) {
  const [draft, setDraft] = useState<AgentDraft>();
  const [catalog, setCatalog] = useState<PluginCatalog>({ plugins: [] });
  const [callId, setCallId] = useState<string>();
  const [error, setError] = useState<string>();
  const [disabled, setDisabled] = useState(false);
  const [running, setRunning] = useState(false);
  const stream = useEventStream<FixtureEvent>(
    callId ? `/api/v1/calls/${encodeURIComponent(callId)}/stream` : undefined,
  );
  useEffect(() => {
    void Promise.all([
      apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}`),
      apiRequest<PluginCatalog>('/plugins'),
    ])
      .then(([agent, plugins]) => {
        setDraft(normalizeDraft(agent.data, agent.etag));
        setCatalog(plugins.data);
      })
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Test console unavailable'),
      );
  }, [agentId]);
  async function switchPlugin(slot: 'engine' | 'carrier', pluginId: string) {
    if (!draft) return;
    const voice = {
      ...(draft.config.voice ?? { textFilters: [], acknowledgements: [] }),
      [slot]: pluginId ? { plugin: pluginId, config: {} } : undefined,
    };
    const config = { ...draft.config, voice };
    setDraft({ ...draft, config });
    try {
      const result = await apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: { 'if-match': ifMatch(draft.draftVersion) },
        body: JSON.stringify({ config }),
      });
      setDraft(normalizeDraft(result.data, result.etag));
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Draft plugin change could not be saved',
      );
    }
  }
  async function runFixture() {
    setRunning(true);
    setError(undefined);
    setDisabled(false);
    try {
      const { data } = await apiRequest<{ callId: string }>(
        `/agents/${encodeURIComponent(agentId)}/test-calls`,
        { method: 'POST', body: JSON.stringify({ useDraft: true }) },
      );
      setCallId(data.callId);
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.status === 404 &&
        failure.code === 'fixture_calls_disabled'
      )
        setDisabled(true);
      else setError(failure instanceof Error ? failure.message : 'Fixture call failed');
    } finally {
      setRunning(false);
    }
  }
  const transcript = stream.events.filter((event) => Boolean(field(event, 'text')));
  const stages = stream.events.filter((event) => Boolean(field(event, 'stage')));
  const cost = [...stream.events].reverse().find((event) => field(event, 'costPaise'));
  return (
    <div className="ui-stack">
      <PageHeader
        eyebrow="Protocol fixture"
        title="Test this agent"
        description="Run a fixture call with the current draft and inspect each stage as it arrives."
      />
      <Callout tone="warning">Live dialing disabled — protocol fixtures</Callout>
      {error && <Callout tone="danger">{error}</Callout>}
      {disabled && (
        <EmptyState title="Fixture calls unavailable">
          Fixture test calls are disabled on this installation. Ask an administrator to enable
          protocol fixtures.
        </EmptyState>
      )}
      <div className="ui-grid">
        <label>
          Engine
          <select
            value={draft?.config.voice?.engine?.plugin ?? ''}
            onChange={(event) => void switchPlugin('engine', event.target.value)}
          >
            <option value="">Distribution default</option>
            {catalog.plugins
              .filter((plugin) => plugin.kind === 'engine')
              .map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.ui?.label ?? plugin.id}
                </option>
              ))}
          </select>
        </label>
        <label>
          Carrier
          <select
            value={draft?.config.voice?.carrier?.plugin ?? ''}
            onChange={(event) => void switchPlugin('carrier', event.target.value)}
          >
            <option value="">No carrier selected</option>
            {catalog.plugins
              .filter((plugin) => plugin.kind === 'carrier')
              .map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.ui?.label ?? plugin.id}
                </option>
              ))}
          </select>
        </label>
      </div>
      <button
        className="button primary align-start"
        type="button"
        disabled={running || disabled}
        onClick={() => void runFixture()}
      >
        {running ? 'Starting…' : 'Run fixture test call'}
      </button>
      {callId && (
        <>
          <p>
            <a className="table-link" href={`/calls/${encodeURIComponent(callId)}`}>
              Inspect call {callId}
            </a>{' '}
            ·{' '}
            <StatusBadge tone={stream.status === 'live' ? 'good' : 'warning'}>
              {stream.status}
            </StatusBadge>
          </p>
          <div className="ui-grid">
            <section className="panel panel-body">
              <h2>Live transcript</h2>
              <ol aria-live="polite">
                {transcript.map((event, index) => (
                  <li key={event.eventId ?? index}>
                    <strong>
                      {field(event, 'speaker') ??
                        (/agent/i.test(event.kind ?? '') ? 'Agent' : 'User')}{' '}
                      · {transcriptPhase(event)}
                    </strong>{' '}
                    {field(event, 'text')}
                  </li>
                ))}
              </ol>
            </section>
            <section className="panel panel-body">
              <h2>Stage timeline</h2>
              <ol>
                {stages.map((event, index) => (
                  <li key={event.eventId ?? index}>{field(event, 'stage')}</li>
                ))}
              </ol>
              <p>Cost so far: {field(cost ?? {}, 'costPaise') ?? 'unpriced'}</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
