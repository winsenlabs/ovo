import { EmptyStateV2, ErrorState } from '../ui/feedback-v2';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import type { RoutingAvailability } from '../../lib/types/routing';

/** The honest state of a routing screen whose feature is off, still loading or failed to load. */
export function RoutingUnavailable({
  state,
  onRetry,
  what = 'Routing',
}: {
  state: Exclude<RoutingAvailability, { kind: 'ready' }>;
  onRetry?: () => void;
  what?: string;
}) {
  if (state.kind === 'loading')
    return (
      <KpiStrip>
        {['Status', 'Mode'].map((label) => (
          <KpiCard key={label} label={label} loading />
        ))}
      </KpiStrip>
    );
  if (state.kind === 'error')
    return (
      <ErrorState title={`${what} could not be loaded`} message={state.message} onRetry={onRetry} />
    );
  return (
    <EmptyStateV2 variant="unavailable" title={`${what} is not enabled here`}>
      Switch it on for this installation (OVO_ROUTING_ENABLED) to route callers by language and
      intent. Calls keep going straight to their agent until then.
    </EmptyStateV2>
  );
}

/** A routing page frame for the states where no data is shown: header, then the state. */
export function RoutingUnavailablePage({
  title,
  state,
  onRetry,
  eyebrow = 'Inbound',
  description,
}: {
  title: string;
  state: Exclude<RoutingAvailability, { kind: 'ready' }>;
  onRetry?: () => void;
  eyebrow?: string;
  description?: string;
}) {
  return (
    <div className="ds-stack rt-page">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <RoutingUnavailable state={state} onRetry={onRetry} />
    </div>
  );
}
