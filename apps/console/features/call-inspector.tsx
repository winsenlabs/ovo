'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { apiRequest, ApiError } from '../lib/api';
import { useSession } from '../components/shell/session-provider';
import type { CallEvidence } from '../lib/derive/call-detail';
import { primaryCost } from '../lib/derive/call-detail';
import { useTurns, turnSummary } from '../components/inspector/turn-model';
import { PageHeader } from '../components/ui/layout';
import { KpiCard, KpiStrip } from '../components/ui/kpi';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { IdChip } from '../components/ui/section-card';
import { Tabs, type TabItem } from '../components/ui/tabs';
import { Skeleton, ErrorState, EmptyStateV2 } from '../components/ui/feedback-v2';
import { Duration, Money } from '../components/ui/display';
import { CodeBlock } from '../components/ui/code-block';
import { humaniseEnum } from '../lib/status';
import { formatDateTime, shortenId } from '../lib/format';
import { ConversationTab } from '../components/inspector/conversation-tab';
import { LatencyTab } from '../components/inspector/latency-tab';
import { CallOutcomePanel } from './call-outcome-panel';
import { CostPanel } from '../components/inspector/cost-panel';
import { EventsTab } from '../components/inspector/events-tab';
import { LiveRecordingsPanel } from '../components/operations/live-recordings-panel';

const TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'latency', label: 'Latency' },
  { id: 'outcome', label: 'Outcome & routing' },
  { id: 'cost', label: 'Cost' },
  { id: 'events', label: 'Events' },
  { id: 'recording', label: 'Recording files' },
  { id: 'raw', label: 'Raw' },
] satisfies TabItem[];

function downloadEvidenceHref(evidence: CallEvidence): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(evidence, null, 2))}`;
}

/**
 * The call inspector: one header with the call's identity and meta, a KPI strip, and the detail
 * split into tabs so each heavy region (turns, outcome, cost, events, recordings) can load — and
 * fail — on its own (brief §3 CALLS "Call detail / inspector").
 */
export function CallInspectorFeature({ callId }: { callId: string }) {
  const identity = useSession();
  const [evidence, setEvidence] = useState<CallEvidence>();
  const [error, setError] = useState<ApiError | Error>();
  const [tab, setTab] = useState<string>('conversation');
  const [agentName, setAgentName] = useState<string>();

  const load = useCallback(() => {
    setEvidence(undefined);
    setError(undefined);
    void apiRequest<CallEvidence>(`/calls/${encodeURIComponent(callId)}/evidence`)
      .then(({ data }) => setEvidence(data))
      .catch((failure) =>
        setError(failure instanceof Error ? failure : new Error('Call evidence unavailable')),
      );
  }, [callId]);
  useEffect(load, [load]);

  const agentId = evidence?.call.agentId;
  useEffect(() => {
    if (!agentId) return;
    void apiRequest<{ config?: { name?: string } }>(`/agents/${encodeURIComponent(agentId)}`)
      .then(({ data }) => setAgentName(data.config?.name))
      .catch(() => setAgentName(undefined));
  }, [agentId]);

  const { turns, error: turnsError } = useTurns(callId);
  const summary = useMemo(() => turnSummary(turns ?? []), [turns]);
  const cost = useMemo(() => primaryCost(evidence?.cost), [evidence?.cost]);
  const availableTabs = useMemo(
    () => TABS.filter((item) => item.id !== 'recording' || evidence?.call.kind === 'live'),
    [evidence?.call.kind],
  );

  if (error) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="ds-stack">
        <PageHeader
          eyebrow="Call inspector"
          title={notFound ? 'Call not found' : `Call ${callId}`}
        />
        {notFound ? (
          <EmptyStateV2
            variant="first-run"
            title="Call not found"
            action={
              <Link href="/calls" className="button">
                Back to calls
              </Link>
            }
          />
        ) : (
          <ErrorState
            message={error.message}
            onRetry={load}
            stillWorks="Other calls and screens are unaffected."
          />
        )}
      </div>
    );
  }
  if (!evidence)
    return (
      <div className="ds-stack">
        <PageHeader eyebrow="Call inspector" title="Loading call…" />
        <KpiStrip>
          {Array.from({ length: 6 }, (_, index) => (
            <KpiCard key={index} label="" value={null} loading />
          ))}
        </KpiStrip>
        <Skeleton shape="chart" width="100%" />
      </div>
    );

  const { call, diagnosis, selections } = evidence;
  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Call inspector"
        title={`${agentName ?? 'Agent'} call`}
        description={`Started ${formatDateTime(call.createdAt)}`}
        meta={
          <div className="ui-cluster">
            <StatusBadgeV2 value={call.status} />
            <span className="ds-chip">{humaniseEnum(call.kind)}</span>
            <span className="ds-chip">
              <Duration ms={call.durationMs} />
            </span>
            {call.releaseId && agentId && (
              <IdChip
                id={call.releaseId}
                short={shortenId(call.releaseId)}
                href={`/agents/${agentId}/releases`}
              />
            )}
            {evidence.sttMode && <span className="ds-chip">{humaniseEnum(evidence.sttMode)}</span>}
            <IdChip id={call.id} short={shortenId(call.id)} />
          </div>
        }
        actions={
          <a
            className="button"
            href={downloadEvidenceHref(evidence)}
            download={`${call.id}-evidence.json`}
          >
            Export evidence
          </a>
        }
      />
      <KpiStrip>
        <KpiCard label="Duration" value={<Duration ms={call.durationMs} />} />
        <KpiCard
          label="Turns"
          value={turns ? summary.turns : null}
          loading={!turns && !turnsError}
        />
        <KpiCard
          label="First audio"
          value={summary.p50 != null ? <Duration ms={summary.p50} /> : null}
          footnote={
            summary.p95 != null ? (
              <>
                p95 <Duration ms={summary.p95} />
              </>
            ) : undefined
          }
          loading={!turns && !turnsError}
        />
        <KpiCard
          label="Interruptions"
          value={turns ? summary.interrupted : null}
          loading={!turns && !turnsError}
        />
        <KpiCard
          label="Cost"
          value={
            cost ? (
              <Money
                minorUnits={cost.totalMinor}
                currency={cost.currency}
                provisional={cost.provisional}
              />
            ) : null
          }
          footnote={cost?.others.length ? cost.others.join(' · ') : undefined}
        />
        <KpiCard label="Errors" value={diagnosis?.errors.length ?? 0} />
      </KpiStrip>
      {Object.keys(selections ?? {}).length > 0 && (
        <div className="ui-cluster">
          {Object.entries(selections!).map(([slot, selection]) => (
            <span
              key={slot}
              className="ds-chip"
              title={`${slot}: ${selection.pluginId}@${selection.resolvedVersion ?? selection.version}`}
            >
              {humaniseEnum(slot)}: {selection.pluginId}@
              {selection.resolvedVersion ?? selection.version}
            </span>
          ))}
        </div>
      )}
      <Tabs items={availableTabs} current={tab} onSelect={setTab} panelId="call-tab-panel" />
      <div id="call-tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'conversation' && (
          <ConversationTab
            callId={callId}
            evidence={evidence}
            turns={turns}
            turnsError={turnsError}
          />
        )}
        {tab === 'latency' && <LatencyTab turns={turns} error={turnsError} />}
        {tab === 'outcome' && <CallOutcomePanel callId={callId} />}
        {tab === 'cost' && <CostPanel callId={callId} cost={evidence.cost} />}
        {tab === 'events' && <EventsTab callId={callId} evidence={evidence} />}
        {tab === 'recording' && call.kind === 'live' && (
          <LiveRecordingsPanel
            call={{
              id: call.id,
              agentId: call.agentId,
              releaseId: call.releaseId,
              kind: call.kind as 'live' | 'simulation' | 'real',
              status: call.status,
              createdAt: call.createdAt,
              completedAt: call.completedAt,
            }}
            role={identity.role}
          />
        )}
        {tab === 'raw' && (
          <CodeBlock code={() => JSON.stringify(evidence, null, 2)} filename={`${call.id}.json`} />
        )}
      </div>
    </div>
  );
}
