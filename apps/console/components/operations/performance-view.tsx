'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import type { PerformanceResult } from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

const groups = [
  'time',
  'agent',
  'release',
  'provider',
  'model',
  'language',
  'stage',
  'source',
] as const;
const localValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

export function PerformanceView() {
  const [from, setFrom] = useState(() => localValue(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(() => localValue(new Date()));
  const [bucket, setBucket] = useState<'hour' | 'day'>('hour');
  const [groupBy, setGroupBy] = useState<string[]>(['time', 'stage']);
  const [filters, setFilters] = useState({
    agentId: '',
    releaseId: '',
    provider: '',
    model: '',
    language: '',
    stage: '',
    source: '',
  });
  const [result, setResult] = useState<PerformanceResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      bucket,
      groupBy: groupBy.join(','),
      maxGroups: '100',
      callLimit: '25',
    });
    Object.entries(filters).forEach(([key, value]) => value && query.set(key, value));
    try {
      setResult((await apiRequest<PerformanceResult>(`/performance?${query}`)).data);
    } catch (failure) {
      setResult(undefined);
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Performance telemetry is not configured on this installation.'
          : failure instanceof Error
            ? failure.message
            : 'Performance evidence unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [bucket, filters, from, groupBy, to]);
  useEffect(() => {
    void load();
  }, []); // initial bounded query only
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };
  const patchFilter = (key: keyof typeof filters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Operational evidence</p>
          <h1>Performance</h1>
          <p className="muted">
            Bounded latency cohorts from durable telemetry. Missing samples remain unavailable,
            never zero.
          </p>
        </div>
      </header>
      <Panel labelledBy="performance-query-title">
        <PanelHeader
          id="performance-query-title"
          title="Cohort query"
          badge={<StatusBadge tone="soft">Maximum 100 groups</StatusBadge>}
        />
        <form className="panel-body stack" onSubmit={submit}>
          <div className="form-grid">
            <Field label="From" htmlFor="perf-from">
              <input
                id="perf-from"
                type="datetime-local"
                required
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label="To" htmlFor="perf-to">
              <input
                id="perf-to"
                type="datetime-local"
                required
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
            <Field label="Bucket" htmlFor="perf-bucket">
              <select
                id="perf-bucket"
                value={bucket}
                onChange={(event) => setBucket(event.target.value as 'hour' | 'day')}
              >
                <option value="hour">Hour</option>
                <option value="day">Day</option>
              </select>
            </Field>
            <Field label="Source" htmlFor="perf-source">
              <select
                id="perf-source"
                value={filters.source}
                onChange={(event) => patchFilter('source', event.target.value)}
              >
                <option value="">All sources</option>
                <option value="live">Live</option>
                <option value="simulation">Simulation</option>
              </select>
            </Field>
          </div>
          <fieldset className="checkbox-group">
            <legend>Group results by</legend>
            {groups.map((group) => (
              <label key={group}>
                <input
                  type="checkbox"
                  checked={groupBy.includes(group)}
                  onChange={(event) =>
                    setGroupBy((current) =>
                      event.target.checked
                        ? [...current, group]
                        : current.filter((item) => item !== group),
                    )
                  }
                />{' '}
                {group}
              </label>
            ))}
          </fieldset>
          <details className="filter-box">
            <summary>Exact filters</summary>
            <div className="form-grid">
              {(['agentId', 'releaseId', 'provider', 'model', 'language', 'stage'] as const).map(
                (key) => (
                  <Field key={key} label={key} htmlFor={`perf-${key}`}>
                    <input
                      id={`perf-${key}`}
                      value={filters[key]}
                      onChange={(event) => patchFilter(key, event.target.value)}
                    />
                  </Field>
                ),
              )}
            </div>
          </details>
          <button className="button primary align-start" disabled={!groupBy.length}>
            Run cohort query
          </button>
        </form>
      </Panel>
      {loading ? (
        <LoadingBlock label="Loading performance cohorts" />
      ) : error ? (
        <Notice tone="warning">{error}</Notice>
      ) : !result?.groups.length ? (
        <EmptyState title="No telemetry matched">
          Change the bounded range or filters. This empty result is not a zero-latency claim.
        </EmptyState>
      ) : (
        <Panel labelledBy="performance-results-title">
          <PanelHeader
            id="performance-results-title"
            title="Cohort evidence"
            badge={
              <StatusBadge tone={result.truncated ? 'warning' : 'good'}>
                {result.groups.length} groups{result.truncated ? ' · truncated' : ''}
              </StatusBadge>
            }
          />
          <div className="panel-body stack">
            {result.ingestion && (
              <div className="metrics">
                <div>
                  <span>Accepted</span>
                  <strong>{result.ingestion.accepted}</strong>
                  <small>Ingested events</small>
                </div>
                <div>
                  <span>Dropped</span>
                  <strong>{result.ingestion.dropped}</strong>
                  <small>Not represented below</small>
                </div>
                <div>
                  <span>Queued</span>
                  <strong>{result.ingestion.queued}</strong>
                  <small>
                    {result.ingestion.closed ? 'Ingestion closed' : 'Current process queue'}
                  </small>
                </div>
              </div>
            )}
            <ResponsiveTable label="Performance cohort results">
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Calls / samples</th>
                  <th>Errors / timeouts</th>
                  <th>P50</th>
                  <th>P95</th>
                  <th>P99</th>
                  <th>Evidence calls</th>
                </tr>
              </thead>
              <tbody>
                {result.groups.map((row, index) => (
                  <tr key={`${JSON.stringify(row.cohort)}-${index}`}>
                    <td>
                      {Object.entries(row.cohort).map(([key, value]) => (
                        <small key={key}>
                          <strong>{key}</strong>: {value ?? 'none'}
                        </small>
                      ))}
                    </td>
                    <td>
                      {row.callCount} / {row.sampleCount}
                      <small>{row.eventCount} events</small>
                    </td>
                    <td>
                      {row.errors} / {row.timeouts}
                    </td>
                    <td>{row.p50Ms === null ? '—' : `${row.p50Ms} ms`}</td>
                    <td>{row.p95Ms === null ? '—' : `${row.p95Ms} ms`}</td>
                    <td>{row.p99Ms === null ? '—' : `${row.p99Ms} ms`}</td>
                    <td>
                      {row.callIds.length
                        ? row.callIds.map((id) => (
                            <a className="table-link mono" href="/calls" key={id}>
                              {id.slice(0, 8)}
                            </a>
                          ))
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        </Panel>
      )}
    </div>
  );
}
