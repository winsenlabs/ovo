'use client';
import type { ReadonlyURLSearchParams } from 'next/navigation';
import {
  FilterBar,
  DateRangePicker,
  type CustomRange,
  type RangePreset,
} from '../../../components/ui/toolbar';
import { Select } from '../../../components/ui/inputs';
import { CALL_STATUS_KEYS } from '../../../lib/derive/calls';
import { humaniseEnum, humaniseKey } from '../../../lib/status';
import { KindSegmented, type CallKind } from './calls-controls';
import type { PluginOption } from './plugin-options';

export const SERVER_FILTERS = ['agentId', 'kind', 'status', 'engine', 'carrier'] as const;

const FILTER_KEY_LABELS: Record<string, string> = {
  agentId: 'Agent',
  kind: 'Kind',
  status: 'Status',
  engine: 'Engine',
  carrier: 'Carrier',
};

/** The Calls list filter row: agent/kind/status/engine/carrier hit the API (URL-synced), search
 * and the date range are client-side over the loaded page. */
export function CallsFilterBar({
  search,
  setFilter,
  onClearAll,
  queryText,
  setQueryText,
  agents,
  engines,
  carriers,
  range,
  setRange,
  custom,
  setCustom,
}: {
  search: ReadonlyURLSearchParams;
  setFilter: (key: string, value: string) => void;
  onClearAll: () => void;
  queryText: string;
  setQueryText: (value: string) => void;
  agents: Map<string, string>;
  engines: PluginOption[];
  carriers: PluginOption[];
  range: RangePreset;
  setRange: (value: RangePreset) => void;
  custom: CustomRange;
  setCustom: (value: CustomRange) => void;
}) {
  const activeChips = [...SERVER_FILTERS, 'q'].filter((key) =>
    key === 'q' ? queryText : search.get(key),
  );
  // M3: raw `agentId: rel_003_emi_re` chips — a humanised key label plus the agent name/plugin
  // label/humanised enum each filter actually renders elsewhere in the row.
  const chipValueLabel = (key: string, value: string): string => {
    switch (key) {
      case 'agentId':
        return agents.get(value) ?? value;
      case 'engine':
        return engines.find((option) => option.id === value)?.label ?? value;
      case 'carrier':
        return carriers.find((option) => option.id === value)?.label ?? value;
      default:
        return humaniseEnum(value);
    }
  };
  return (
    <FilterBar
      search={queryText}
      onSearch={setQueryText}
      searchPlaceholder="Search call ID"
      chips={activeChips.map((key) => ({
        id: key,
        label:
          key === 'q'
            ? `ID: ${queryText}`
            : `${FILTER_KEY_LABELS[key] ?? humaniseKey(key)}: ${chipValueLabel(key, search.get(key)!)}`,
      }))}
      onClearChip={(id) => (id === 'q' ? setQueryText('') : setFilter(id, ''))}
      onClearAll={() => {
        setQueryText('');
        onClearAll();
      }}
      filters={
        <>
          <Select
            aria-label="Agent"
            value={search.get('agentId') ?? ''}
            onChange={(value) => setFilter('agentId', value)}
            placeholder="All agents"
            options={[...agents.entries()].map(([id, name]) => ({ value: id, label: name }))}
          />
          <KindSegmented
            value={(search.get('kind') as CallKind | '') || ''}
            onChange={(value) => setFilter('kind', value)}
          />
          <Select
            aria-label="Status"
            value={search.get('status') ?? ''}
            onChange={(value) => setFilter('status', value)}
            placeholder="All statuses"
            options={CALL_STATUS_KEYS.map((key) => ({ value: key, label: humaniseEnum(key) }))}
          />
          <Select
            aria-label="Engine"
            value={search.get('engine') ?? ''}
            onChange={(value) => setFilter('engine', value)}
            placeholder="All engines"
            options={engines.map((option) => ({ value: option.id, label: option.label }))}
          />
          <Select
            aria-label="Carrier"
            value={search.get('carrier') ?? ''}
            onChange={(value) => setFilter('carrier', value)}
            placeholder="All carriers"
            options={carriers.map((option) => ({ value: option.id, label: option.label }))}
          />
          <DateRangePicker
            value={range}
            onChange={setRange}
            custom={custom}
            onCustomChange={setCustom}
          />
        </>
      }
    />
  );
}

/** Chip ids currently active, for the empty-state copy ("No calls match. Clear filters."). */
export function activeChipCount(search: ReadonlyURLSearchParams, queryText: string): number {
  return [...SERVER_FILTERS, 'q'].filter((key) => (key === 'q' ? queryText : search.get(key)))
    .length;
}
