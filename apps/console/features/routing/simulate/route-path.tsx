'use client';
import { ProgressMeter } from '../../../components/charts/meter';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { ENGINE_LABEL, FALLBACK_LABEL } from '../../../lib/derive/routing-labels';
import { pathItems, targetLine, type Attempt } from '../../../lib/derive/routing-path';
import type { RoutingSimulationResult } from '../../../lib/types/routing-simulate';

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  matched: 'ok',
  low_confidence: 'warn',
  no_match: 'neutral',
  timeout: 'danger',
  error: 'danger',
  disabled: 'neutral',
};
const engineName = (engine: string) =>
  engine in ENGINE_LABEL
    ? ENGINE_LABEL[engine as keyof typeof ENGINE_LABEL]
    : engine === 'context'
      ? 'Route context'
      : engine;

function AttemptChip({ attempt }: { attempt: Attempt }) {
  return (
    <li className="rt-attempt">
      <span>
        {engineName(attempt.engine)}
        {attempt.mocked ? ' (scripted)' : ''}
      </span>
      <StatusBadgeV2
        tone={TONE[attempt.outcome] ?? 'neutral'}
        size="sm"
        label={attempt.outcome.replaceAll('_', ' ')}
      />
      {attempt.branch && <span className="mono">{attempt.branch}</span>}
      {attempt.confidence !== undefined && (
        <ProgressMeter
          label={`Confidence of ${engineName(attempt.engine)}`}
          value={Math.round(attempt.confidence * 100)}
          max={100}
          valueLabel={`${Math.round(attempt.confidence * 100)}%`}
        />
      )}
    </li>
  );
}

/** The run as a chain of questions, the engines tried on each, any fallbacks, and where it ended. */
export function RoutePath({ result }: { result: RoutingSimulationResult }) {
  const items = pathItems(result);
  return (
    <ol className="rt-path" aria-label="Route taken">
      {items.map((item, i) =>
        item.kind === 'node' ? (
          <li key={i} className="rt-path-node">
            <strong className="mono">{item.node}</strong>
            <ul className="rt-attempts">
              {item.attempts.map((a, n) => (
                <AttemptChip key={n} attempt={a} />
              ))}
            </ul>
            {item.chosen && (
              <span className="rt-edge">
                chose <span className="mono">{item.chosen}</span>
              </span>
            )}
          </li>
        ) : (
          <li key={i} className="rt-path-fallback">
            <StatusBadgeV2 tone="warn" size="sm" label="Fallback" />{' '}
            {FALLBACK_LABEL[item.step as keyof typeof FALLBACK_LABEL] ?? item.step} on{' '}
            <span className="mono">{item.node}</span>: {item.result}
            {item.reason && <span className="muted"> ({item.reason.replaceAll('_', ' ')})</span>}
          </li>
        ),
      )}
      <li className={`rt-path-target status-${result.outcome.status}`}>
        <strong>{targetLine(result)}</strong>
        {result.outcome.line && <span className="muted">Router says: “{result.outcome.line}”</span>}
        {result.outcome.degraded && (
          <StatusBadgeV2
            tone="warn"
            size="sm"
            label={`Degraded: ${result.outcome.degraded.replaceAll('_', ' ')}`}
          />
        )}
      </li>
    </ol>
  );
}
