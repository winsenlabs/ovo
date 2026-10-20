'use client';
import type { SessionIdentity } from '../../lib/api';
import type { RoutingEvalRunSummary } from '../../lib/data/routing-eval-api';
import { Button } from '../ui/button';
import type { ColumnV2 } from '../ui/data-table-v2';
import { Percent, RelativeTime } from '../ui/display';

export const pct = (value: number | null) => (value == null ? null : <Percent value={value} />);

export function runColumns(
  role: SessionIdentity['role'],
  open: (run: RoutingEvalRunSummary) => void,
  remove: (run: RoutingEvalRunSummary) => void,
): ColumnV2<RoutingEvalRunSummary>[] {
  return [
    {
      id: 'name',
      header: 'Run',
      priority: 'high',
      cell: (run) => (
        <button
          type="button"
          className="text-button"
          aria-label={`Open run ${run.name}`}
          onClick={() => open(run)}
        >
          {run.name}
        </button>
      ),
    },
    {
      id: 'release',
      header: 'Release',
      priority: 'normal',
      cell: (run) => `v${run.releaseVersion}`,
    },
    { id: 'cases', header: 'Cases', priority: 'low', align: 'end', cell: (run) => run.caseCount },
    {
      id: 'passed',
      header: 'Passed',
      priority: 'high',
      align: 'end',
      sortValue: (run) => run.headline.passed,
      cell: (run) => `${run.headline.passed} / ${run.headline.total}`,
    },
    {
      id: 'accuracy',
      header: 'Accuracy',
      priority: 'high',
      align: 'end',
      sortValue: (run) => run.headline.accuracy ?? -1,
      cell: (run) => pct(run.headline.accuracy) ?? <span className="ds-unknown">—</span>,
    },
    {
      id: 'created',
      header: 'Run',
      priority: 'normal',
      sortValue: (run) => Date.parse(run.createdAt),
      cell: (run) => <RelativeTime value={run.createdAt} />,
    },
    { id: 'by', header: 'By', priority: 'low', cell: (run) => run.createdBy },
    ...(role === 'viewer'
      ? []
      : [
          {
            id: 'actions',
            header: 'Actions',
            priority: 'normal' as const,
            cell: (run: RoutingEvalRunSummary) => (
              <Button
                type="button"
                variant="danger"
                aria-label={`Delete run ${run.name}`}
                onClick={() => remove(run)}
              >
                Delete
              </Button>
            ),
          },
        ]),
  ];
}
