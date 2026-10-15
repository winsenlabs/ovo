'use client';
import { CHART_PALETTE } from '../../../components/charts/scale';
import { humaniseEnum } from '../../../lib/status';

export const CALL_KINDS = ['live', 'test', 'simulation'] as const;
export type CallKind = (typeof CALL_KINDS)[number];

/**
 * "All / Live / Test / Simulation" (brief §3 CALLS). Reuses the same `ds-range-picker` radiogroup
 * markup `DateRangePicker` already draws its presets with, for a visually consistent segmented
 * control without a new foundation primitive.
 */
export function KindSegmented({
  value,
  onChange,
}: {
  value: CallKind | '';
  onChange: (value: CallKind | '') => void;
}) {
  return (
    <div className="ds-range-picker" role="radiogroup" aria-label="Call kind">
      <button
        type="button"
        role="radio"
        aria-checked={value === ''}
        className={value === '' ? 'selected' : ''}
        onClick={() => onChange('')}
      >
        All
      </button>
      {CALL_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="radio"
          aria-checked={value === kind}
          className={value === kind ? 'selected' : ''}
          onClick={() => onChange(kind)}
        >
          {humaniseEnum(kind)}
        </button>
      ))}
    </div>
  );
}

const TIER_ORDER = ['rule', 'jev', 'llm', 'event', 'none'] as const;
const TIER_COLOR: Record<string, string> = {
  rule: CHART_PALETTE[0],
  jev: CHART_PALETTE[1],
  llm: CHART_PALETTE[3],
  event: CHART_PALETTE[6],
  none: 'var(--neutral)',
};

/** Inline rule/Jev/LLM mini-bar for a call row's `outcome.tiers`, so the table shows which tier
 * carried the call without opening the inspector. */
export function RouteTierBar({ tiers }: { tiers: Record<string, number> }) {
  const shares = TIER_ORDER.map((tier) => ({ tier, count: tiers[tier] ?? 0 })).filter(
    (share) => share.count > 0,
  );
  const total = shares.reduce((sum, share) => sum + share.count, 0);
  if (!total) return <span className="ds-unknown">—</span>;
  const summary = shares.map((share) => `${humaniseEnum(share.tier)} ${share.count}`).join(', ');
  return (
    <span
      className="ds-route-tier-bar"
      role="img"
      aria-label={`Routed by ${summary}`}
      style={{ display: 'inline-flex', width: 56, height: 8, gap: 1, verticalAlign: 'middle' }}
    >
      {shares.map((share) => (
        <span
          key={share.tier}
          title={`${humaniseEnum(share.tier)}: ${share.count}`}
          style={{
            width: `${(share.count / total) * 100}%`,
            background: TIER_COLOR[share.tier] ?? 'var(--neutral)',
            borderRadius: 2,
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  );
}
