'use client';
import { StatusBadgeV2 } from '../ui/status-badge';
import { humaniseEnum, type Tone } from '../../lib/status';
import { TARGET_LABELS } from '../../lib/derive/call-route-summary';
import type { PathFallback, PathStep, RoutePath } from '../../lib/derive/call-route-path';

const OUTCOME_TONE: Record<string, Tone> = {
  matched: 'ok',
  no_match: 'warn',
  low_confidence: 'warn',
  timeout: 'danger',
  error: 'danger',
  disabled: 'neutral',
};
const FALLBACK_TONE: Record<string, Tone> = { taken: 'warn', skipped: 'neutral', failed: 'danger' };

const percent = (value: number) => `${Math.round(value * 100)}%`;

function engineText(step: PathStep): string {
  const engine = step.engine ? humaniseEnum(step.engine) : 'No engine';
  const parts = [engine];
  if (step.outcome && step.outcome !== 'matched') parts.push(humaniseEnum(step.outcome));
  if (step.confidence != null) parts.push(percent(step.confidence));
  return parts.join(' · ');
}

function FallbackBadge({ fallback }: { fallback: PathFallback }) {
  const attempt = fallback.attempt > 1 ? ` ${fallback.attempt}` : '';
  return (
    <StatusBadgeV2
      size="sm"
      tone={FALLBACK_TONE[fallback.result] ?? 'neutral'}
      label={`Fallback: ${humaniseEnum(fallback.step)}${attempt} ${fallback.result}${fallback.reason ? ` (${humaniseEnum(fallback.reason)})` : ''}`}
    />
  );
}

/**
 * The route as a trail of nodes: for each the engine that decided it with its confidence, the
 * branch it chose, and any fallback that ran there. Ends in where the caller was sent.
 */
export function RoutePathChips({
  path,
  target,
  targetNote,
}: {
  path: RoutePath;
  target: string | null;
  targetNote?: string;
}) {
  if (!path.steps.length && !target) return null;
  return (
    <nav aria-label="Route path">
      <ol className="route-path">
        {path.steps.map((step) => (
          <li key={step.node} className="route-step">
            <span className="ds-chip mono">{step.node}</span>
            <span className="route-step-detail">
              <StatusBadgeV2
                size="sm"
                tone={OUTCOME_TONE[step.outcome ?? ''] ?? 'neutral'}
                label={engineText(step)}
              />
              {step.branch && (
                <span className="route-branch">
                  <span aria-hidden="true">→ </span>
                  <span className="sr-only">chose </span>
                  {step.branch}
                </span>
              )}
              {step.attempts > 1 && <small className="muted">{step.attempts} attempts</small>}
              {step.fallbacks.map((fallback, index) => (
                <FallbackBadge key={index} fallback={fallback} />
              ))}
            </span>
          </li>
        ))}
        {path.loose.map((fallback, index) => (
          <li key={`loose-${index}`} className="route-step">
            <FallbackBadge fallback={fallback} />
          </li>
        ))}
        {target && (
          <li className="route-step route-step-target">
            <span className="ds-chip">
              <span className="sr-only">Sent to </span>
              {TARGET_LABELS[target] ?? humaniseEnum(target)}
            </span>
            {targetNote && <small className="muted">{targetNote}</small>}
          </li>
        )}
      </ol>
    </nav>
  );
}
