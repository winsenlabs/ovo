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
import { humaniseEnum } from '../../../lib/status';
import { KindSegmented, type CallKind } from './calls-controls';
import type { PluginOption } from './plugin-options';

export const SERVER_FILTERS = ['agentId', 'kind', 'status', 'engine', 'carrier'] as const;

/** The Calls list filter row: agent/kind/status/engine/carrier hit the API (URL-synced), search
 * and the date range are client-side over the loaded page. */
export function CallsFilterBar({
  search,
  setFilter,
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
  return (
    <FilterBar
      search={queryText}
      onSearch={setQueryText}
      searchPlaceholder="Search call ID"
      chips={activeChips.map((key) => ({
        id: key,
        label: key === 'q' ? `ID: ${queryText}` : `${key}: ${search.get(key)}`,
      }))}
      onClearChip={(id) => (id === 'q' ? setQueryText('') : setFilter(id, ''))}
      onClearAll={() => {
        setQueryText('');
        for (const key of SERVER_FILTERS) setFilter(key, '');
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
