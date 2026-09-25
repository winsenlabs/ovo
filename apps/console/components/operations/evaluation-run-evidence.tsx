'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type {
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationRunRecord,
} from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  JsonEvidence,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

type Page<T> = { items: T[]; nextCursor?: string };

export function EvaluationRunEvidence({
  role,
  runs,
  focusRunId,
  reload,
  reportError,
}: {
  role: SessionIdentity['role'];
  runs: EvaluationRunRecord[];
  focusRunId?: string;
  reload: () => Promise<void>;
  reportError: (message: string) => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState('');
  const [results, setResults] = useState<EvaluationCaseResult[]>([]);
  const [comparison, setComparison] = useState<EvaluationComparison>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelectedRunId((current) =>
      focusRunId && runs.some((run) => run.id === focusRunId)
        ? focusRunId
        : current && runs.some((run) => run.id === current)
          ? current
          : runs[0]?.id || '',
    );
  }, [focusRunId, runs]);
  useEffect(() => {
    if (!selectedRunId) return setResults([]);
    void loadRunResults(selectedRunId)
      .then(setResults)
      .catch((failure) => reportError(message(failure, 'Evaluation results could not be loaded.')));
  }, [reportError, selectedRunId]);

  async function cancel(run: EvaluationRunRecord) {
    setBusy(true);
    try {
      await apiRequest(`/evaluation-runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' });
      await reload();
    } catch (failure) {
      reportError(message(failure, 'Evaluation run could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  }

  async function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    try {
      setComparison(
        (
          await apiRequest<EvaluationComparison>('/evaluation-runs/compare', {
            method: 'POST',
            body: JSON.stringify({
              baselineRunId: values.get('baselineRunId'),
              candidateRunId: values.get('candidateRunId'),
            }),
          })
        ).data,
      );
    } catch (failure) {
      reportError(message(failure, 'Evaluation runs could not be compared.'));
    } finally {
      setBusy(false);
    }
  }

  const selectedRun = runs.find((run) => run.id === selectedRunId);
  if (runs.length === 0)
    return (
      <EmptyState title="No durable evaluation runs">
        Import a corpus version and queue a fixture-only evaluation.
      </EmptyState>
    );
  return (
    <>
      <ResponsiveTable label="Evaluation runs">
        <thead>
          <tr>
            <th>Run</th>
            <th>Executor</th>
            <th>Status</th>
            <th>Evidence</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                >
                  {run.id}
                </button>
                <small>dataset v{run.datasetVersion}</small>
              </td>
              <td>
                {run.executorKind}
                {run.budgetAuthorizationId && (
                  <small className="mono">Authorization {run.budgetAuthorizationId}</small>
                )}
              </td>
              <td>
                <StatusBadge
                  tone={
                    run.status === 'succeeded'
                      ? 'good'
                      : run.status === 'failed'
                        ? 'danger'
                        : 'soft'
                  }
                >
                  {run.status}
                </StatusBadge>
              </td>
              <td>
                {run.passed} passed · {run.failed} failed · {run.total} total
              </td>
              <td>
                {role !== 'viewer' && ['queued', 'running', 'cancelling'].includes(run.status) ? (
                  <button
                    className="text-button danger-text"
                    type="button"
                    disabled={busy}
                    onClick={() => cancel(run)}
                  >
                    Cancel
                  </button>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
      {selectedRun && (
        <section className="nested-card stack">
          <div className="split-row">
            <div>
              <h4>Run case evidence</h4>
              <p className="muted mono">{selectedRun.id}</p>
            </div>
            <button className="button" type="button" onClick={() => void reload()}>
              Refresh jobs
            </button>
          </div>
          {results.length === 0 ? (
            <div className="muted">No case results have been persisted yet.</div>
          ) : (
            <ResponsiveTable label="Evaluation case results">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Mode</th>
                  <th>Result</th>
                  <th>Duration</th>
                  <th>Output/error</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.caseId}>
                    <td>{result.caseId}</td>
                    <td>{result.mode}</td>
                    <td>
                      <StatusBadge tone={result.passed ? 'good' : 'danger'}>
                        {result.passed ? 'Passed' : 'Failed'}
                      </StatusBadge>
                    </td>
                    <td>{result.durationMs} ms</td>
                    <td>{result.error ?? (result.outputs.join(' · ') || '—')}</td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          )}
        </section>
      )}
      {runs.length >= 2 && (
        <form className="nested-card stack" onSubmit={compare}>
          <h4>Compare immutable runs</h4>
          <div className="form-grid">
            <Field label="Baseline" htmlFor="compare-baseline">
              <select id="compare-baseline" name="baselineRunId" defaultValue={runs[1]?.id}>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Candidate" htmlFor="compare-candidate">
              <select id="compare-candidate" name="candidateRunId" defaultValue={runs[0]?.id}>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button className="button align-start" disabled={busy}>
            Compare results
          </button>
          {comparison && <JsonEvidence label="Regression comparison" value={comparison} />}
        </form>
      )}
    </>
  );
}

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

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
