'use client';
import { useEffect, useState } from 'react';
import type { CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import { apiRequest } from '../lib/api';
import { EmptyStateV2 } from '../components/ui/feedback-v2';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { KeyValueGrid } from '../components/ui/section-card';
import { KpiCard, KpiStrip } from '../components/ui/kpi';
import { ChartFrame } from '../components/charts/chart-frame';
import { Donut } from '../components/charts/donut';
import { DataTableV2, type ColumnV2 } from '../components/ui/data-table-v2';
import { dataTableRenderKey } from '../lib/data-table-remount-key';
import { Percent } from '../components/ui/display';
import { humaniseEnum, type Tone } from '../lib/status';

// The route-tier table has no natural status to read a tone from, but leaving every row the same
// colour (what passing a fixed `tone` did before) makes the column read as decoration, not data —
// rule is the cheapest/most deterministic path, Jev the primary decision engine, the LLM the most
// expensive fallback, in roughly that reliability order.
const TIER_TONE: Record<string, Tone> = { rule: 'ok', jev: 'info', llm: 'warn' };
function tierTone(tier: string): Tone {
  return TIER_TONE[tier.toLowerCase()] ?? 'neutral';
}

type SessionEvent = {
  sequence: number;
  at: string;
  type: string;
  payload: Record<string, unknown>;
};
export type CallOutcomeResponse = {
  available: boolean;
  summary: CallOutcomeSummary | null;
  events: SessionEvent[];
};

const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
const confidence = (value: unknown) => (typeof value === 'number' ? value : null);

interface RouteDecisionRow {
  sequence: number;
  turn: unknown;
  tier: unknown;
  node: unknown;
  intent: unknown;
  confidence: unknown;
  fallbackReason: unknown;
}

/**
 * The Outcome & routing tab (AGT-8): the disposition, the state path the call actually took, the
 * values the caller gave, every routing decision with the tier that answered it (and how
 * confident), and every guardrail verdict.
 */
export function CallOutcomePanel({ callId }: { callId: string }) {
  const [outcome, setOutcome] = useState<CallOutcomeResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void apiRequest<CallOutcomeResponse>(`/calls/${encodeURIComponent(callId)}/outcome?limit=500`)
      .then(({ data }) => setOutcome(data))
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Call outcome unavailable'),
      );
  }, [callId]);
  if (error)
    return (
      <EmptyStateV2 variant="unavailable" title="Outcome unavailable">
        {error}
      </EmptyStateV2>
    );
  if (!outcome)
    return (
      <KpiStrip>
        <KpiCard label="Disposition" value={null} loading />
      </KpiStrip>
    );
  const summary = outcome.summary;
  if (!summary)
    return (
      <EmptyStateV2 variant="first-run" title="No outcome recorded">
        {outcome.available
          ? 'This call recorded no routing decisions or disposition.'
          : 'This installation does not store call outcomes (PostgreSQL only).'}
      </EmptyStateV2>
    );
  const decisions: RouteDecisionRow[] = outcome.events
    .filter((event) => event.type === 'turn.route')
    .map((event) => ({
      sequence: event.sequence,
      turn: event.payload.turn,
      tier: event.payload.tier,
      node: event.payload.node,
      intent: event.payload.intent,
      confidence: event.payload.confidence,
      fallbackReason: event.payload.fallbackReason,
    }));
  const guardrail = outcome.events.filter((event) => event.type === 'guardrail');
  const variables = Object.entries(summary.variables);
  const tierSlices = Object.entries(summary.tiers)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([label, value]) => ({ label: humaniseEnum(label), value: value ?? 0 }));
  const columns: ColumnV2<RouteDecisionRow>[] = [
    { id: 'turn', header: 'Turn', cell: (row) => text(row.turn) },
    {
      id: 'tier',
      header: 'Tier',
      cell: (row) => (
        <StatusBadgeV2 tone={tierTone(text(row.tier))} label={humaniseEnum(text(row.tier))} />
      ),
    },
    { id: 'node', header: 'Node', cell: (row) => humaniseEnum(text(row.node)) },
    { id: 'intent', header: 'Intent', cell: (row) => humaniseEnum(text(row.intent)) },
    {
      id: 'confidence',
      header: 'Confidence',
      align: 'end',
      cell: (row) => {
        const value = confidence(row.confidence);
        if (value == null) return '—';
        return (
          <span
            className="ds-meter"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <span
              className="ds-meter-track"
              style={{ width: 48, display: 'inline-block' }}
              role="img"
              aria-label={`Confidence ${Math.round(value * 100)}%`}
            >
              <span className="ds-meter-fill tone-ok" style={{ width: `${value * 100}%` }} />
            </span>
            <Percent value={value} digits={0} />
          </span>
        );
      },
    },
    {
      id: 'fallback',
      header: 'Fallback',
      priority: 'low',
      cell: (row) => text(row.fallbackReason),
    },
  ];
  return (
    <div className="ds-stack">
      <KpiStrip>
        <KpiCard
          label="Disposition"
          value={humaniseEnum(summary.disposition)}
          footnote={
            summary.dispositionSource ? `via ${humaniseEnum(summary.dispositionSource)}` : undefined
          }
        />
        <KpiCard label="Outcome" value={humaniseEnum(summary.outcome)} />
        <KpiCard
          label="Final node"
          value={summary.finalNode ? humaniseEnum(summary.finalNode) : null}
        />
        {summary.guardrail.flagged + summary.guardrail.blocked > 0 && (
          <KpiCard
            label="Guardrail"
            value={`${summary.guardrail.flagged} flagged`}
            footnote={`${summary.guardrail.blocked} blocked`}
          />
        )}
      </KpiStrip>
      {summary.statePath.length > 0 && (
        <nav aria-label="State path" className="ui-cluster">
          {summary.statePath.map((node, index) => (
            <span key={`${node}-${index}`} className="ds-chip">
              {index > 0 && <span aria-hidden="true">→ </span>}
              {humaniseEnum(node)}
            </span>
          ))}
        </nav>
      )}
      <div className="ui-grid">
        {variables.length > 0 && (
          <KeyValueGrid
            items={variables.map(([key, value]) => ({
              label: humaniseEnum(key),
              value: typeof value === 'string' ? value : JSON.stringify(value),
              mono: typeof value !== 'string',
            }))}
          />
        )}
        <ChartFrame
          title="Route tiers"
          ariaLabel="Share of turns routed by each tier"
          height={180}
          empty={!tierSlices.length}
          tableRows={tierSlices.length}
          tableColumns={[
            { header: 'Tier', cell: (i) => tierSlices[i]!.label },
            { header: 'Turns', cell: (i) => tierSlices[i]!.value },
          ]}
          renderChart={() => <Donut slices={tierSlices} centerLabel={String(decisions.length)} />}
        />
      </div>
      <DataTableV2
        key={dataTableRenderKey(false, undefined, decisions.length)}
        label="Routing decisions"
        rows={decisions}
        rowKey={(row) => String(row.sequence)}
        columns={columns}
        empty="No routing decisions recorded"
      />
      {guardrail.length > 0 && (
        <ol className="ds-stack" aria-label="Guardrail verdicts">
          {guardrail.map((event) => (
            <li key={event.sequence}>
              Turn {text(event.payload.turn)} · {humaniseEnum(text(event.payload.action))}:{' '}
              {(event.payload.findings as { kind: string; text: string }[])
                .map((finding) => `${finding.kind} "${finding.text}"`)
                .join(', ')}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
