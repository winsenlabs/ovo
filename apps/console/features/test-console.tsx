'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, apiRequest, ifMatch, normalizeDraft, type AgentDraft } from '../lib/api';
import { useEventStream } from '../lib/data/use-event-stream';
import type { PluginCatalog } from '../components/plugins/types';
import { humanisePluginId } from '../components/plugins/schema-field-helpers';
import { SubPageHeader } from '../components/studio/sub-page-header';
import { SectionCard } from '../components/ui/section-card';
import { EmptyStateV2, InlineAlert, Skeleton } from '../components/ui/feedback-v2';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { Stepper, type StepState } from '../components/ui/stepper';
import { Conversation, type ConversationLine } from '../components/ui/conversation';
import { Money } from '../components/ui/display';
import { field, STAGE_ORDER, transcriptPhase, type FixtureEvent } from '../lib/derive/test-run';

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
  const reachedStage = new Set(stages.map((event) => field(event, 'stage')));
  // A transcript line with `phase: 'played'` is the agent's reply actually reaching the caller —
  // the one signal that survives regardless of which intermediate `stage` events a given backend
  // chooses to emit. Without it, a backend that never sends a literal `stage: 'played'` frame (for
  // example, one that reports progress through a separate telemetry channel instead) left the
  // stepper parked on "accepted" forever, even after a full, successful run (verifier: "after a
  // full run the stepper still marks only accepted as current").
  const reachedPlayed = transcript.some((event) => transcriptPhase(event) === 'played');
  const lastStageIndex = reachedPlayed
    ? STAGE_ORDER.length - 1
    : STAGE_ORDER.reduce((last, stage, index) => (reachedStage.has(stage) ? index : last), -1);
  const lines: ConversationLine[] = transcript.map((event, index) => ({
    id: event.eventId ?? String(index),
    speaker: /agent/i.test(field(event, 'speaker') ?? event.kind ?? '') ? 'agent' : 'caller',
    atMs: event.atMs ?? index * 1000,
    text: field(event, 'text') ?? '',
    interim: transcriptPhase(event) === 'interim',
    played: transcriptPhase(event) !== 'generated',
  }));

  return (
    <div className="ui-stack">
      <SubPageHeader
        eyebrow="Protocol fixture"
        title="Test this agent"
        description="Run a fixture call with the current draft and inspect each stage as it arrives."
      />
      <InlineAlert tone="warn">Live dialing disabled — protocol fixtures only.</InlineAlert>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {disabled && (
        <EmptyStateV2 variant="unavailable" title="Fixture calls unavailable">
          Fixture test calls are disabled on this installation. Ask an administrator to enable
          protocol fixtures.
        </EmptyStateV2>
      )}
      <div className="inspector-grid">
        {/* `alignSelf: 'start'`: `.inspector-grid`'s row otherwise stretches this card to match
            the transcript column's height, leaving its own short form pinned to the bottom of a
            mostly empty card (verifier). */}
        <div style={{ alignSelf: 'start' }}>
          <SectionCard title="Run configuration">
            {!draft ? (
              <Skeleton shape="block" />
            ) : (
              <div className="ui-stack">
                <label htmlFor="test-engine">
                  Engine
                  <select
                    id="test-engine"
                    value={draft.config.voice?.engine?.plugin ?? ''}
                    onChange={(event) => void switchPlugin('engine', event.target.value)}
                  >
                    <option value="">Distribution default</option>
                    {catalog.plugins
                      .filter((plugin) => plugin.kind === 'engine')
                      .map((plugin) => (
                        <option key={plugin.id} value={plugin.id}>
                          {plugin.ui?.label ?? humanisePluginId(plugin.id)}
                        </option>
                      ))}
                  </select>
                </label>
                <label htmlFor="test-carrier">
                  Carrier
                  <select
                    id="test-carrier"
                    value={draft.config.voice?.carrier?.plugin ?? ''}
                    onChange={(event) => void switchPlugin('carrier', event.target.value)}
                  >
                    <option value="">No carrier selected</option>
                    {catalog.plugins
                      .filter((plugin) => plugin.kind === 'carrier')
                      .map((plugin) => (
                        <option key={plugin.id} value={plugin.id}>
                          {plugin.ui?.label ?? humanisePluginId(plugin.id)}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="button primary"
                  type="button"
                  disabled={running || disabled}
                  onClick={() => void runFixture()}
                >
                  {running ? 'Starting…' : 'Run fixture test call'}
                </button>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="ui-stack">
          {!callId ? (
            <EmptyStateV2 variant="first-run" title="Nothing running yet">
              Run a fixture call to hear this draft without dialing anyone.
            </EmptyStateV2>
          ) : (
            <>
              <SectionCard
                title="Live run"
                actions={
                  <StatusBadgeV2
                    tone={stream.status === 'live' ? 'ok' : 'warn'}
                    label={stream.status}
                  />
                }
              >
                {/* The stepper's own flex row has no wrap; inside the narrower "Live run" card
                    (or at 390px) its six steps ran past the card's right edge (verifier). Scoping
                    the scroll to this wrapper keeps every step reachable without touching the
                    shared `Stepper` component other screens also use unwrapped. */}
                <div style={{ overflowX: 'auto' }}>
                  <Stepper
                    steps={STAGE_ORDER.map((stage, index): { label: string; state: StepState } => ({
                      label: stage,
                      state:
                        index < lastStageIndex
                          ? 'done'
                          : index === lastStageIndex
                            ? 'current'
                            : 'upcoming',
                    }))}
                  />
                </div>
                <p className="ui-cluster">
                  <Link className="table-link" href={`/calls/${encodeURIComponent(callId)}`}>
                    Open in call inspector
                  </Link>
                  {cost && (
                    <span>
                      Running cost · <Money minorUnits={field(cost, 'costPaise')} />
                    </span>
                  )}
                </p>
              </SectionCard>
              <SectionCard title="Transcript">
                {lines.length ? (
                  <Conversation lines={lines} />
                ) : (
                  <EmptyStateV2 variant="first-run" title="Waiting for the first turn…" />
                )}
              </SectionCard>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
