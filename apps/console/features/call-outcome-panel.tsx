'use client';
import { useEffect, useState } from 'react';
import type { CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import { apiRequest } from '../lib/api';
import { EmptyState, StatusBadge } from '../components/ui/feedback';

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

const percent = (value: unknown) =>
  typeof value === 'number' ? `${Math.round(value * 100)}%` : '—';
const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '—';

/**
 * What the call decided (AGT-8): its disposition, the state path it took, the values the caller
 * gave, every routing decision with the tier that answered it, and every guardrail verdict.
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
  if (error) return <p role="alert">{error}</p>;
  if (!outcome) return <p role="status">Loading call outcome…</p>;
  const summary = outcome.summary;
  if (!summary)
    return (
      <EmptyState title="No outcome recorded">
        {outcome.available
          ? 'This call recorded no routing decisions or disposition.'
          : 'This installation does not store call outcomes (PostgreSQL only).'}
      </EmptyState>
    );
  const decisions = outcome.events.filter((event) => event.type === 'turn.route');
  const guardrail = outcome.events.filter((event) => event.type === 'guardrail');
  const variables = Object.entries(summary.variables);
  return (
    <div className="ui-stack">
      <div className="ui-cluster">
        <StatusBadge tone={summary.disposition ? 'good' : 'soft'}>
          {summary.disposition ?? 'No disposition'}
        </StatusBadge>
        <span>Outcome: {summary.outcome ?? 'Not ended'}</span>
        {summary.endReason && <span className="mono">{summary.endReason}</span>}
        <span>Final node: {summary.finalNode ?? '—'}</span>
        {Object.entries(summary.tiers).map(([tier, count]) => (
          <span key={tier} className="badge soft">
            {tier}: {count}
          </span>
        ))}
        {summary.guardrail.flagged + summary.guardrail.blocked > 0 && (
          <StatusBadge tone="warning">
            Guardrail: {summary.guardrail.flagged} flagged · {summary.guardrail.blocked} blocked
          </StatusBadge>
        )}
      </div>
      {summary.statePath.length > 0 && (
        <nav aria-label="State path">
          <ol className="ui-cluster">
            {summary.statePath.map((node, index) => (
              <li key={`${node}-${index}`} className="mono">
                {index ? '→ ' : ''}
                {node}
              </li>
            ))}
          </ol>
        </nav>
      )}
      {variables.length > 0 && (
        <dl aria-label="Captured variables">
          {variables.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className="mono">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <table aria-label="Routing decisions">
        <thead>
          <tr>
            <th>Turn</th>
            <th>Tier</th>
            <th>Node</th>
            <th>Intent</th>
            <th>Confidence</th>
            <th>Fallback</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((event) => (
            <tr key={event.sequence}>
              <td>{text(event.payload.turn)}</td>
              <td>{text(event.payload.tier)}</td>
              <td>{text(event.payload.node)}</td>
              <td>{text(event.payload.intent)}</td>
              <td>{percent(event.payload.confidence)}</td>
              <td>{text(event.payload.fallbackReason)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {guardrail.length > 0 && (
        <ol aria-label="Guardrail verdicts">
          {guardrail.map((event) => (
            <li key={event.sequence}>
              Turn {text(event.payload.turn)} · {text(event.payload.action)}:{' '}
              {(event.payload.findings as { kind: string; text: string }[])
                .map((finding) => `${finding.kind} “${finding.text}”`)
                .join(', ')}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
