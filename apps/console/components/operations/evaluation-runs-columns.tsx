import type { EvaluationDataset, EvaluationRunRecord } from '../../lib/operator-api';
import type { SessionIdentity } from '../../lib/api';
import { formatDuration, formatRelativeTime } from '../../lib/format';
import { humaniseEnum } from '../../lib/status';
import { runDurationMs } from '../../lib/derive/evaluations';
import type { ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { Button } from '../ui/button';

const CANCELLABLE = new Set(['queued', 'running', 'cancelling']);
const NO_OUTCOME_YET = new Set(['queued', 'running', 'cancelling', 'cancelled']);

/** Column defs for the evaluation runs table, extracted so `EvaluationRunsPanel` stays under the
 * module-size gate. Status uses the one shared tone map — running/queued read as info, not the
 * green "succeeded" tone the old table gave every status (brief defect #14). */
export function buildRunColumns({
  datasets,
  role,
  busy,
  onSelect,
  onCancel,
}: {
  datasets: readonly EvaluationDataset[];
  role: SessionIdentity['role'];
  busy: boolean;
  onSelect: (run: EvaluationRunRecord) => void;
  onCancel: (run: EvaluationRunRecord) => void;
}): ColumnV2<EvaluationRunRecord>[] {
  return [
    {
      id: 'run',
      header: 'Run',
      cell: (run) => (
        <button className="text-button" type="button" onClick={() => onSelect(run)}>
          <span className="mono">{run.id.slice(0, 12)}</span>
        </button>
      ),
    },
    {
      id: 'dataset',
      header: 'Dataset',
      cell: (run) =>
        `${datasets.find((d) => d.id === run.datasetId)?.name ?? run.datasetId} v${run.datasetVersion}`,
    },
    { id: 'executor', header: 'Executor', cell: (run) => humaniseEnum(run.executorKind) },
    {
      id: 'status',
      header: 'Status',
      cell: (run) => <StatusBadgeV2 value={run.status} />,
      sortValue: (run) => run.status,
    },
    {
      id: 'result',
      header: 'Pass / fail',
      cell: (run) => {
        const evaluated = run.passed + run.failed;
        // A queued/running/cancelling run, or one cancelled before any case ran, has no outcome
        // yet: `0/24 · 0%` read as a 0% pass rate rather than "nothing has run" (verifier medium
        // #11). Only render real numbers once something has actually been evaluated, or the run
        // reached a terminal, scored status.
        if (evaluated === 0 && NO_OUTCOME_YET.has(run.status)) {
          return <span className="muted">—</span>;
        }
        const pct = run.total ? Math.round((run.passed / run.total) * 100) : null;
        return (
          <span
            style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}
          >
            <span>
              <span className="mono">
                {run.passed}/{run.total}
              </span>{' '}
              <small className="muted">{pct != null ? `${pct}%` : '—'}</small>
            </span>
            <span
              style={{
                display: 'flex',
                width: 64,
                height: 6,
                borderRadius: 3,
                overflow: 'hidden',
                background: 'var(--border)',
              }}
              role="img"
              aria-label={`${run.passed} passed, ${run.failed} failed, of ${run.total}`}
            >
              <span
                style={{
                  width: `${run.total ? (run.passed / run.total) * 100 : 0}%`,
                  background: 'var(--ok-text)',
                }}
              />
              <span
                style={{
                  width: `${run.total ? (run.failed / run.total) * 100 : 0}%`,
                  background: 'var(--danger-text)',
                }}
              />
            </span>
          </span>
        );
      },
      align: 'end',
    },
    {
      id: 'duration',
      header: 'Duration',
      cell: (run) => {
        const ms = runDurationMs(run);
        return ms == null ? '—' : formatDuration(ms);
      },
      align: 'end',
    },
    {
      id: 'started',
      header: 'Started',
      cell: (run) => formatRelativeTime(run.createdAt),
      sortValue: (run) => run.createdAt,
    },
    {
      id: 'action',
      header: '',
      cell: (run) =>
        role !== 'viewer' && CANCELLABLE.has(run.status) ? (
          <Button variant="danger" type="button" disabled={busy} onClick={() => onCancel(run)}>
            Cancel
          </Button>
        ) : null,
      align: 'end',
    },
  ];
}
