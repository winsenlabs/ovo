'use client';
import type { RoutingEvalRun } from '../../lib/data/routing-eval-api';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { KeyValueGrid, SectionCard } from '../ui/section-card';
import { Duration, Percent } from '../ui/display';
import { dataTableRenderKey } from '../../lib/data-table-remount-key';
import { shortenId } from '../../lib/format';
import { humaniseEnum } from '../../lib/status';
import { ConfusionTable } from './routing-eval-confusion';
import { accuracyRows, describeRecord, engineRows, type AccuracyRow } from './routing-eval-model';

const rate = (value: number | null) =>
  value == null ? <span className="ds-unknown">—</span> : <Percent value={value} />;

const ACCURACY_COLUMNS: ColumnV2<AccuracyRow>[] = [
  { id: 'field', header: 'Field', cell: (row) => humaniseEnum(row.field) },
  { id: 'correct', header: 'Correct', align: 'end', cell: (row) => row.correct },
  { id: 'total', header: 'Asserted by', align: 'end', cell: (row) => `${row.total} cases` },
  {
    id: 'rate',
    header: 'Accuracy',
    align: 'end',
    cell: (row) => (row.total ? rate(row.rate) : <span className="muted">Not asserted</span>),
  },
];

function DrawerTable<T>({
  label,
  rows,
  columns,
  rowKey,
  empty,
}: {
  label: string;
  rows: readonly T[];
  columns: ColumnV2<T>[];
  rowKey: (row: T) => string;
  empty: string;
}) {
  return (
    <SectionCard title={label} padding="flush">
      <DataTableV2
        key={dataTableRenderKey(false, undefined, rows.length)}
        label={label}
        rows={rows}
        rowKey={rowKey}
        columns={columns}
        empty={<EmptyStateV2 variant="first-run" title={empty} />}
      />
    </SectionCard>
  );
}

export function RunBody({ run }: { run: RoutingEvalRun }) {
  const card = run.scorecard;
  const confusion = Object.entries(card.confusion ?? {});
  return (
    <div className="ds-stack">
      <KeyValueGrid
        columns={3}
        items={[
          { label: 'Release', value: `v${run.releaseVersion}` },
          { label: 'Cases', value: `${card.totals.passed} of ${card.totals.cases} passed` },
          { label: 'Engines', value: run.engineMode === 'live' ? 'Live' : 'Scripted answers' },
          { label: 'Fallback rate', value: rate(card.fallbackRate.rate) },
          { label: 'Clarify rate', value: rate(card.clarifyRate.rate) },
          { label: 'Ended or undecided', value: rate(card.endRate.rate) },
          {
            label: 'Corpus',
            value: shortenId(run.corpusDigest, 10, 4),
            mono: true,
            copy: run.corpusDigest,
          },
          { label: 'Run by', value: run.createdBy },
          { label: 'Run time', value: <Duration ms={card.ms.total} /> },
        ]}
      />
      <DrawerTable
        label="Accuracy per field"
        rows={accuracyRows(card)}
        rowKey={(row) => row.field}
        columns={ACCURACY_COLUMNS}
        empty="No accuracy recorded"
      />
      <DrawerTable
        label="Per engine"
        rows={engineRows(card)}
        rowKey={(row) => row.engine}
        empty="No engine was asked"
        columns={[
          { id: 'engine', header: 'Engine', cell: (row) => humaniseEnum(row.engine) },
          { id: 'attempts', header: 'Asked', align: 'end', cell: (row) => row.attempts },
          { id: 'matched', header: 'Matched', align: 'end', cell: (row) => row.matched },
          { id: 'no_match', header: 'No match', align: 'end', cell: (row) => row.no_match },
          { id: 'low', header: 'Low confidence', align: 'end', cell: (row) => row.low_confidence },
          {
            id: 'timeout',
            header: 'Timed out',
            align: 'end',
            priority: 'low',
            cell: (row) => row.timeout,
          },
          {
            id: 'error',
            header: 'Errors',
            align: 'end',
            priority: 'low',
            cell: (row) => row.error,
          },
          {
            id: 'disabled',
            header: 'Disabled',
            align: 'end',
            priority: 'low',
            cell: (row) => row.disabled,
          },
        ]}
      />
      <SectionCard
        title="Confusion matrices"
        description="Per deciding engine: the branch each case expected against the branch chosen."
      >
        {confusion.length ? (
          <div className="ds-stack">
            {confusion.map(([engine, data]) => (
              <ConfusionTable key={engine} engine={engine} data={data} />
            ))}
          </div>
        ) : (
          <EmptyStateV2 variant="first-run" title="No case asserted a branch">
            Add expect.branches to cases to score which branch each engine chose.
          </EmptyStateV2>
        )}
      </SectionCard>
      <DrawerTable
        label="Per node"
        rows={card.perNode}
        rowKey={(row) => row.node}
        empty="No node was visited"
        columns={[
          { id: 'node', header: 'Node', cell: (row) => <span className="mono">{row.node}</span> },
          { id: 'cases', header: 'Cases', align: 'end', cell: (row) => row.cases },
          { id: 'decided', header: 'Decided', align: 'end', cell: (row) => row.decided },
          { id: 'correct', header: 'Correct', align: 'end', cell: (row) => row.correct },
          { id: 'fallbacks', header: 'Fallbacks', align: 'end', cell: (row) => row.fallbacks },
        ]}
      />
      <DrawerTable
        label="Failures"
        rows={card.failures}
        rowKey={(row) => row.id}
        empty="Every case passed"
        columns={[
          { id: 'id', header: 'Case', cell: (row) => <span className="mono">{row.id}</span> },
          { id: 'expected', header: 'Expected', cell: (row) => describeRecord(row.expected) },
          { id: 'actual', header: 'Actual', cell: (row) => describeRecord(row.actual) },
          { id: 'diff', header: 'Differs in', priority: 'low', cell: (row) => row.diff.join(', ') },
        ]}
      />
    </div>
  );
}
