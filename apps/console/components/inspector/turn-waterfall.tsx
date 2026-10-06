'use client';
import { memo, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { EmptyState, StatusBadge } from '../ui/feedback';
import { STAGES, routeLabel, turnParts, turnSummary, type TurnRow } from './turn-model';

/** Rows rendered at first; a call with hundreds of turns shows more on request. */
export const TURN_PAGE = 40;
const stage = Object.fromEntries(STAGES.map((item) => [item.key, item]));
const ms = (value: number | null | undefined) => (value == null ? '—' : `${Math.round(value)} ms`);
const tone = (tier: string) =>
  tier === 'error' ? 'danger' : tier === 'llm' ? 'warning' : tier === 'rule' ? 'good' : 'soft';

const TurnLine = memo(function TurnLine({
  turn,
  index,
  scaleMs,
}: {
  turn: TurnRow;
  index: number;
  scaleMs: number;
}) {
  const { parts, unattributedMs, overlapMs } = turnParts(turn);
  const route = routeLabel(turn);
  const said = (value: string | null) =>
    turn.textOmitted ? 'Text not stored' : value?.trim() || '—';
  const width = (value: number) => `${Math.min(100, (100 * value) / scaleMs)}%`;
  return (
    <li className="panel panel-body" aria-label={`Turn ${index + 1}`}>
      <div className="ui-cluster">
        <strong>
          {index + 1} · {turn.input}
        </strong>
        <span>
          First audio <strong>{ms(turn.firstAudioMs)}</strong>
        </span>
        {route && <StatusBadge tone={tone(route.tier)}>{route.text}</StatusBadge>}
        {turn.decision?.flow && (
          <span className="mono">
            {turn.decision.flow.node ?? '—'} / {turn.decision.flow.listen}
          </span>
        )}
        {turn.interrupted && (
          <StatusBadge tone="warning">Interrupted · {ms(turn.bargeInMs)}</StatusBadge>
        )}
      </div>
      {turn.input !== 'agent' && turn.input !== 'initial' && (
        <p>
          <small>Caller</small> {said(turn.userText)}
        </p>
      )}
      <p>
        <small>Agent</small> {said(turn.agentText)}
      </p>
      <div
        role="img"
        aria-label={parts.map((part) => `${stage[part.key]!.label} ${ms(part.ms)}`).join(', ')}
        style={{ display: 'flex', height: 'var(--space-3)', gap: 1, width: '100%' }}
      >
        {parts.map((part) => (
          <span
            key={part.key}
            title={`${stage[part.key]!.label}: ${ms(part.ms)}`}
            style={{ width: width(part.ms), background: stage[part.key]!.color, minWidth: 2 }}
          />
        ))}
        {unattributedMs > 0 && (
          <span
            title={`Unattributed: ${ms(unattributedMs)}`}
            style={{ width: width(unattributedMs), background: 'var(--color-border)' }}
          />
        )}
      </div>
      <small>
        {parts.map((part) => `${stage[part.key]!.label} ${ms(part.ms)}`).join(' · ') ||
          'No stage timings recorded'}
        {overlapMs > 0 && ` · stages overlap by ${ms(overlapMs)}`}
        {turn.llmTotalMs != null && ` · LLM total ${ms(turn.llmTotalMs)}`}
      </small>
    </li>
  );
});

/**
 * OBS-7: one row per turn from `GET /v1/calls/:id/turns`: what the caller said and the agent
 * answered, which tier routed it, and a stacked waterfall of its stages to first audio. Rows are
 * memoised and rendered a page at a time, so a call with hundreds of turns stays responsive.
 */
export function TurnWaterfall({ callId }: { callId: string }) {
  const [turns, setTurns] = useState<TurnRow[]>();
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState(TURN_PAGE);
  useEffect(() => {
    void apiRequest<{ turns: TurnRow[] }>(`/calls/${encodeURIComponent(callId)}/turns`)
      .then(({ data }) => setTurns(data.turns))
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Turn timings unavailable'),
      );
  }, [callId]);
  const summary = useMemo(() => (turns ? turnSummary(turns) : undefined), [turns]);
  // One scale for every row, so bars compare; the slowest 5% do not squash the rest.
  const scaleMs = useMemo(() => {
    const totals = (turns ?? []).map((turn) => turnParts(turn).totalMs).sort((a, b) => a - b);
    return Math.max(1, totals[Math.floor(totals.length * 0.95)] ?? totals.at(-1) ?? 1);
  }, [turns]);
  if (error) return <p role="alert">{error}</p>;
  if (!turns || !summary) return <p role="status">Loading turn timings…</p>;
  if (!turns.length)
    return (
      <EmptyState title="No turn timings recorded">This call has no turn telemetry.</EmptyState>
    );
  return (
    <div className="ui-stack">
      <div className="ui-cluster" aria-label="Turn summary">
        <span>{summary.turns} caller turns</span>
        <span>First audio p50 {ms(summary.p50)}</span>
        <span>p95 {ms(summary.p95)}</span>
        {Object.entries(summary.tiers).map(([tier, count]) => (
          <span key={tier} className="badge soft">
            {tier}: {count}
          </span>
        ))}
        {summary.interrupted > 0 && <span>{summary.interrupted} interrupted</span>}
      </div>
      <ul className="ui-cluster" aria-label="Stage legend">
        {STAGES.map((item) => (
          <li key={item.key}>
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 'var(--space-3)',
                height: 'var(--space-3)',
                background: item.color,
              }}
            />{' '}
            {item.label}
          </li>
        ))}
      </ul>
      <ol className="ui-stack" aria-label="Turns">
        {turns.slice(0, shown).map((turn, index) => (
          <TurnLine key={turn.turnId} turn={turn} index={index} scaleMs={scaleMs} />
        ))}
      </ol>
      {shown < turns.length && (
        <button className="button small" onClick={() => setShown(shown + TURN_PAGE)}>
          Show {Math.min(TURN_PAGE, turns.length - shown)} more of {turns.length - shown} turns
        </button>
      )}
    </div>
  );
}
