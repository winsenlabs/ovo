'use client';
import { useState } from 'react';
import { Select } from '../ui/inputs';
import { DateRangePicker, type CustomRange, type RangePreset } from '../ui/toolbar';
import type { ReleaseOption } from './agent-release-options';

export type PerformanceSource = 'all' | 'live' | 'simulation' | 'test';
export type PerformanceFilters = {
  agentId: string;
  releaseId: string;
  provider: string;
  model: string;
  language: string;
  stage: string;
};

const SOURCES: { id: PerformanceSource; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'test', label: 'Test' },
];

const option = (value: string) => ({ value, label: value });

/**
 * Range + source live at the top of the page (every Insights screen gets the same shape);
 * the exact-match filters (agent/release/provider/model/language/stage) collapse into a
 * disclosure so the query form never dominates the page the way it used to (brief defect #13).
 */
export function PerformanceFilterBar({
  range,
  onRangeChange,
  custom,
  onCustomChange,
  source,
  onSourceChange,
  filters,
  onFiltersChange,
  agents,
  releases,
  providers,
  models,
  languages,
  stages,
}: {
  range: RangePreset;
  onRangeChange: (value: RangePreset) => void;
  custom?: CustomRange;
  onCustomChange: (value: CustomRange) => void;
  source: PerformanceSource;
  onSourceChange: (value: PerformanceSource) => void;
  filters: PerformanceFilters;
  onFiltersChange: (filters: PerformanceFilters) => void;
  agents: readonly { id: string; name: string }[];
  releases: readonly ReleaseOption[];
  providers: readonly string[];
  models: readonly string[];
  languages: readonly string[];
  stages: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const activeCount = Object.values(filters).filter(Boolean).length;
  const patch = (key: keyof PerformanceFilters, value: string) =>
    onFiltersChange({ ...filters, [key]: value });

  return (
    <div className="ds-toolbar">
      <DateRangePicker
        value={range}
        onChange={onRangeChange}
        custom={custom}
        onCustomChange={onCustomChange}
      />
      <div className="ds-range-picker" role="radiogroup" aria-label="Call source">
        {SOURCES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={source === item.id}
            className={source === item.id ? 'selected' : ''}
            onClick={() => onSourceChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <details
        className="ds-filter-bar"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="button">Filters{activeCount > 0 ? ` · ${activeCount}` : ''}</summary>
        <div className="form-grid" style={{ marginTop: 'var(--space-2)' }}>
          <div className="field">
            <label htmlFor="perf-filter-agent">Agent</label>
            <Select
              id="perf-filter-agent"
              value={filters.agentId}
              onChange={(value) => patch('agentId', value)}
              placeholder="All agents"
              options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            />
          </div>
          <div className="field">
            <label htmlFor="perf-filter-release">Release</label>
            <Select
              id="perf-filter-release"
              value={filters.releaseId}
              onChange={(value) => patch('releaseId', value)}
              placeholder="All releases"
              options={releases.map((release) => ({
                value: release.id,
                label: `${release.agentName} · ${release.id.slice(0, 8)}`,
              }))}
            />
          </div>
          <div className="field">
            <label htmlFor="perf-filter-provider">Provider</label>
            <Select
              id="perf-filter-provider"
              value={filters.provider}
              onChange={(value) => patch('provider', value)}
              placeholder="All providers"
              options={providers.map(option)}
            />
          </div>
          <div className="field">
            <label htmlFor="perf-filter-model">Model</label>
            <Select
              id="perf-filter-model"
              value={filters.model}
              onChange={(value) => patch('model', value)}
              placeholder="All models"
              options={models.map(option)}
            />
          </div>
          <div className="field">
            <label htmlFor="perf-filter-language">Language</label>
            <Select
              id="perf-filter-language"
              value={filters.language}
              onChange={(value) => patch('language', value)}
              placeholder="All languages"
              options={languages.map(option)}
            />
          </div>
          <div className="field">
            <label htmlFor="perf-filter-stage">Stage</label>
            <Select
              id="perf-filter-stage"
              value={filters.stage}
              onChange={(value) => patch('stage', value)}
              placeholder="All stages"
              options={stages.map(option)}
            />
          </div>
        </div>
        {activeCount > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onFiltersChange({
                agentId: '',
                releaseId: '',
                provider: '',
                model: '',
                language: '',
                stage: '',
              })
            }
          >
            Clear filters
          </button>
        )}
      </details>
    </div>
  );
}
