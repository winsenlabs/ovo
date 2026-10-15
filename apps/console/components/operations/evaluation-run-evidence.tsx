'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import type {
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationRunRecord,
} from '../../lib/operator-api';
import { humaniseEnum } from '../../lib/status';
import { formatDuration } from '../../lib/format';
import { Drawer } from '../ui/drawer';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { SectionCard } from '../ui/section-card';
import { Select } from '../ui/inputs';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { loadCases } from './load-evaluation-cases';

type Page<T> = { items: T[]; nextCursor?: string };

async function loadRunResults(runId: string): Promise<EvaluationCaseResult[]> {
  const collected: EvaluationCaseResult[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const { data } = await apiRequest<Page<EvaluationCaseResult>>(
      `/evaluation-runs/${encodeURIComponent(runId)}/cases?${query}`,
    );
    collected.push(...data.items);
    cursor = data.nextCursor;
  } while (cursor && collected.length < 120);
  return collected.slice(0, 120);
}

/** The run detail drawer: case results, failures first, output/error inline. */
export function EvaluationRunDetailDrawer({
  run,
  open,
  onClose,
}: {
  run: EvaluationRunRecord | null;
  open: boolean;
  onClose: () => void;
}) {
  const [results, setResults] = useState<EvaluationCaseResult[]>([]);
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open || !run) return;
    void loadRunResults(run.id)
      .then(setResults)
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Case results unavailable.'),
      );
    // Best-effort: the dataset version a run was scored against is immutable, so its case
    // titles never drift. If this fails (e.g. the version was since archived), the table falls
    // back to the case ID, same as before.
    void loadCases(run.datasetId, run.datasetVersion)
      .then(setCases)
      .catch(() => setCases([]));
  }, [open, run]);
  const titleByCaseId = new Map(cases.map((item) => [item.id, item.title]));

  const columns: ColumnV2<EvaluationCaseResult>[] = [
    {
      id: 'case',
      header: 'Case',
      // A case ID alone gave no sense of what the case actually tested (verifier minor #13); the
      // immutable dataset version's own case titles resolve it when they loaded successfully.
      cell: (result) => {
        const title = titleByCaseId.get(result.caseId);
        return title ? (
          <>
            {title}
            <br />
            <small className="mono muted">{result.caseId.slice(0, 10)}</small>
          </>
        ) : (
          <span className="mono">{result.caseId}</span>
        );
      },
    },
    { id: 'mode', header: 'Mode', cell: (result) => humaniseEnum(result.mode) },
    {
      id: 'result',
      header: 'Result',
      cell: (result) => (
        <StatusBadgeV2
          tone={result.passed ? 'ok' : 'danger'}
          label={result.passed ? 'Passed' : 'Failed'}
        />
      ),
      sortValue: (result) => (result.passed ? 1 : 0),
    },
    {
      id: 'duration',
      header: 'Duration',
      // Raw milliseconds ("3977 ms") instead of the shared humanised duration (verifier minor
      // #13).
      cell: (result) => formatDuration(result.durationMs),
      align: 'end',
    },
    {
      id: 'output',
      header: 'Output / error',
      cell: (result) => result.error ?? (result.outputs.join(' · ') || '—'),
      priority: 'low',
    },
  ];
  const sorted = [...results].sort((a, b) => Number(a.passed) - Number(b.passed));

  return (
    <Drawer
      open={open}
      title={run ? `Run ${run.id.slice(0, 12)} case results` : 'Run case results'}
      onClose={onClose}
    >
      {error ? (
        <EmptyStateV2 variant="unavailable" title="Could not load case results">
          {error}
        </EmptyStateV2>
      ) : (
        <DataTableV2
          // See price-catalog-panel.tsx: remounts across the empty → loaded boundary (and per
          // run) to avoid DataTableV2's hook-count mismatch (foundation request in the report).
          key={`${run?.id}-${sorted.length > 0}`}
          label="Evaluation case results"
          rows={sorted}
          columns={columns}
          rowKey={(result) => result.caseId}
          empty="No case results have been persisted yet."
        />
      )}
    </Drawer>
  );
}

/** Baseline vs candidate comparison: pass/fail bars plus regression/fix/unchanged lists. */
export function EvaluationRunCompare({ runs }: { runs: readonly EvaluationRunRecord[] }) {
  const [baselineId, setBaselineId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  // `runs` arrives async (it starts `[]`), so the picker defaults to the two most recent runs
  // only once they exist, instead of an empty value that silently falls back to the first
  // <option> in both selects.
  useEffect(() => {
    setBaselineId((current) =>
      current && runs.some((run) => run.id === current) ? current : (runs[1]?.id ?? ''),
    );
    setCandidateId((current) =>
      current && runs.some((run) => run.id === current) ? current : (runs[0]?.id ?? ''),
    );
  }, [runs]);
  const [comparison, setComparison] = useState<EvaluationComparison>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setComparison(
        (
          await apiRequest<EvaluationComparison>('/evaluation-runs/compare', {
            method: 'POST',
            body: JSON.stringify({ baselineRunId: baselineId, candidateRunId: candidateId }),
          })
        ).data,
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Evaluation runs could not be compared.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (runs.length < 2) return null;
  const options = runs.map((run) => ({
    value: run.id,
    label: `${run.id.slice(0, 12)} · ${humaniseEnum(run.status)}`,
  }));
  const rate = (side: { passed: number; total: number }) =>
    side.total ? Math.round((side.passed / side.total) * 100) : 0;

  return (
    <SectionCard title="Compare runs" description="Baseline vs candidate, plus what changed.">
      <form className="ui-cluster" onSubmit={compare}>
        <div className="field">
          <label htmlFor="compare-baseline">Baseline</label>
          <Select
            id="compare-baseline"
            value={baselineId}
            onChange={setBaselineId}
            options={options}
          />
        </div>
        <div className="field">
          <label htmlFor="compare-candidate">Candidate</label>
          <Select
            id="compare-candidate"
            value={candidateId}
            onChange={setCandidateId}
            options={options}
          />
        </div>
        <button className="button primary" disabled={busy}>
          Compare
        </button>
      </form>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      {comparison && (
        <div className="ds-stack">
          <div className="ds-kpi-strip">
            <article className="ds-kpi">
              <p className="ds-kpi-label">Baseline pass rate</p>
              <span className="ds-kpi-value">{rate(comparison.baseline)}%</span>
              <small className="muted">
                {comparison.baseline.passed}/{comparison.baseline.total}
              </small>
            </article>
            <article className="ds-kpi">
              <p className="ds-kpi-label">Candidate pass rate</p>
              <span className="ds-kpi-value">{rate(comparison.candidate)}%</span>
              <small className="muted">
                {comparison.candidate.passed}/{comparison.candidate.total}
              </small>
            </article>
          </div>
          <CaseList title="Regressions" tone="danger" ids={comparison.regressions} />
          <CaseList title="Fixes" tone="ok" ids={comparison.fixes} />
          <CaseList title="Unchanged failures" tone="neutral" ids={comparison.unchangedFailures} />
        </div>
      )}
    </SectionCard>
  );
}

function CaseList({
  title,
  tone,
  ids,
}: {
  title: string;
  tone: 'danger' | 'ok' | 'neutral';
  ids: readonly string[];
}) {
  return (
    <div>
      <h4>
        {title} <StatusBadgeV2 tone={tone} label={String(ids.length)} size="sm" />
      </h4>
      {ids.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {ids.map((id) => (
            <li key={id} className="mono">
              {id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
