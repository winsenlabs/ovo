import type { ReactNode } from 'react';

export const RANGE_PRESETS = ['1h', '24h', '7d', '30d', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** Presets 1h/24h/7d/30d/custom; URL-syncing is the caller's responsibility via `onChange`. */
export function DateRangePicker({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (preset: RangePreset) => void;
}) {
  return (
    <div className="ds-range-picker" role="radiogroup" aria-label="Date range">
      {RANGE_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          role="radio"
          aria-checked={value === preset}
          className={value === preset ? 'selected' : ''}
          onClick={() => onChange(preset)}
        >
          {preset === 'custom' ? 'Custom' : preset}
        </button>
      ))}
    </div>
  );
}

export type FilterChip = { id: string; label: string };

/** Search + filter Selects + active-filter chips with clear-all; URL sync is left to the screen. */
export function FilterBar({
  search,
  onSearch,
  searchPlaceholder = 'Search',
  filters,
  chips,
  onClearChip,
  onClearAll,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  chips?: readonly FilterChip[];
  onClearChip?: (id: string) => void;
  onClearAll?: () => void;
}) {
  return (
    <div className="ds-filter-bar">
      <div className="ds-filter-row">
        {onSearch && (
          <input
            type="search"
            value={search ?? ''}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => onSearch(event.target.value)}
          />
        )}
        {filters}
      </div>
      {chips && chips.length > 0 && (
        <div className="ds-filter-chips">
          {chips.map((chip) => (
            <span key={chip.id} className="ds-chip">
              {chip.label}
              {onClearChip && (
                <button
                  type="button"
                  aria-label={`Clear ${chip.label}`}
                  onClick={() => onClearChip(chip.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {onClearAll && (
            <button type="button" className="text-button" onClick={onClearAll}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="ds-toolbar">{children}</div>;
}
