import type { InfrastructureSnapshot } from '../../lib/operator-api';
import { quotaRatio } from '../../lib/derive/infrastructure';
import { formatDateTime, formatRelativeTime } from '../../lib/format';
import { SectionCard } from '../ui/section-card';
import { ProgressMeter } from '../charts/meter';
import { StatusBadgeV2 } from '../ui/status-badge';
import { EmptyStateV2 } from '../ui/feedback-v2';

const LOW_QUOTA_RATIO = 0.15;

/**
 * Provider quota and throttling as a meter per (provider, metric) instead of a bare
 * remaining/limit number pair — remaining under 15% of the limit reads as danger.
 */
export function ProviderCapacityPanel({ snapshot }: { snapshot: InfrastructureSnapshot }) {
  const quotas = snapshot.providers.quotas ?? [];
  const throttling = snapshot.providers.throttling ?? [];
  if (snapshot.providers.quotas === null && snapshot.providers.throttling === null)
    return (
      <SectionCard title="Provider quota and throttling">
        <EmptyStateV2 variant="unavailable" title="Provider metrics unknown">
          No fresh provider quota or throttle samples were reported.
        </EmptyStateV2>
      </SectionCard>
    );
  return (
    <SectionCard title="Provider quota and throttling">
      {quotas.length === 0 ? (
        <EmptyStateV2 variant="unavailable" title="No quota samples">
          No provider quota samples were reported.
        </EmptyStateV2>
      ) : (
        <div className="ds-stack">
          {quotas.map((quota) => {
            const throttle = throttling.find((item) => item.provider === quota.provider);
            const ratio = quotaRatio(quota.remaining, quota.limit);
            const low = ratio != null && ratio < LOW_QUOTA_RATIO;
            return (
              <div key={`${quota.provider}:${quota.metric}`}>
                <ProgressMeter
                  label={`${quota.provider} · ${quota.metric}`}
                  value={quota.remaining ?? 0}
                  max={Math.max(1, quota.limit ?? quota.remaining ?? 1)}
                  tone={low ? 'danger' : 'ok'}
                  valueLabel={
                    quota.remaining == null || quota.limit == null
                      ? 'Unknown'
                      : `${quota.remaining.toLocaleString('en-IN')} of ${quota.limit.toLocaleString('en-IN')} remaining`
                  }
                />
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                  {throttle?.active ? (
                    <StatusBadgeV2 tone="warn" label={`Throttled · ${throttle.count}`} size="sm" />
                  ) : (
                    <StatusBadgeV2 tone="ok" label="Not throttled" size="sm" />
                  )}
                  {quota.resetAt && <> · Resets {formatRelativeTime(quota.resetAt)}</>}
                  {' · '}Observed {formatDateTime(quota.observedAt)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
