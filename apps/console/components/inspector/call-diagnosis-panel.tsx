'use client';
import { useState } from 'react';
import { Callout, StatusBadge } from '../ui/feedback';

export interface CallDiagnosis {
  endReason: string | null;
  timeout: { stage: string; provider?: string } | null;
  errors: { sequence: number; at: string; type: string; message: string; turnId?: string }[];
  errorsTruncated: boolean;
  speculation: {
    decision?: Record<string, number>;
    llm?: Record<string, number>;
  } | null;
  guardrail: Record<string, unknown> | null;
  evidence: { accepted?: number; dropped?: number; sampled?: number; failed?: number } | null;
}

const ERROR_PAGE = 20;
const STAGE_NAMES: Record<string, string> = {
  carrier_start: 'the carrier never started the media stream',
  route_resolve: 'resolving the call route',
  worker_dial: 'connecting to a worker',
  media_idle: 'media went silent in both directions',
  session_open: 'opening the session',
  stt: 'speech to text',
  tts: 'text to speech',
  llm: 'the LLM',
  decision: 'the decision model',
  tool: 'a tool call',
};

const counts = (record: Record<string, number> | undefined) =>
  Object.entries(record ?? {})
    .map(([key, value]) => `${key} ${value}`)
    .join(' · ');

/**
 * OBS-7: why the call ended and what went wrong. A timeout names its stage and provider (OBS-9),
 * failures are listed in order, speculation shows how often a partial-transcript decision was
 * reused, and lost evidence (OBS-10) is called out so a thin timeline is not mistaken for a quiet
 * call.
 */
export function CallDiagnosisPanel({ diagnosis }: { diagnosis?: CallDiagnosis }) {
  const [shown, setShown] = useState(ERROR_PAGE);
  if (!diagnosis) return <p>No diagnosis recorded for this call.</p>;
  const { timeout, evidence, speculation } = diagnosis;
  const lost = (evidence?.dropped ?? 0) + (evidence?.failed ?? 0);
  return (
    <div className="ui-stack">
      <div className="ui-cluster">
        <span>
          End reason: <span className="mono">{diagnosis.endReason ?? 'not recorded'}</span>
        </span>
        <StatusBadge tone={diagnosis.errors.length ? 'danger' : 'good'}>
          {diagnosis.errors.length
            ? `${diagnosis.errors.length}${diagnosis.errorsTruncated ? '+' : ''} errors`
            : 'No errors'}
        </StatusBadge>
      </div>
      {timeout && (
        <Callout tone="danger">
          Timed out in {STAGE_NAMES[timeout.stage] ?? timeout.stage}
          {timeout.provider ? ` (${timeout.provider})` : ''}.
        </Callout>
      )}
      {lost > 0 && (
        <Callout tone="warning">
          {lost} evidence events were lost ({evidence?.dropped ?? 0} dropped,{' '}
          {evidence?.failed ?? 0} failed to write); the timeline is incomplete.
        </Callout>
      )}
      {speculation && (
        <dl aria-label="Speculation">
          <dt>Decisions on partial transcripts</dt>
          <dd>{counts(speculation.decision) || '—'}</dd>
          <dt>Speculative LLM</dt>
          <dd>{counts(speculation.llm) || '—'}</dd>
        </dl>
      )}
      {diagnosis.errors.length > 0 && (
        <ol aria-label="Errors">
          {diagnosis.errors.slice(0, shown).map((error) => (
            <li key={error.sequence}>
              <span className="mono">{error.type}</span>
              {error.turnId ? ` · turn ${error.turnId}` : ''} · {error.message}{' '}
              <small>{new Date(error.at).toLocaleTimeString()}</small>
            </li>
          ))}
        </ol>
      )}
      {shown < diagnosis.errors.length && (
        <button className="button small" onClick={() => setShown(shown + ERROR_PAGE)}>
          Show more errors
        </button>
      )}
    </div>
  );
}
