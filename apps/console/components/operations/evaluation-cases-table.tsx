import type { EvaluationCase } from '../../lib/operator-api';
import { humaniseEnum } from '../../lib/status';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';

export function EvaluationCasesTable({ cases }: { cases: readonly EvaluationCase[] }) {
  const columns: ColumnV2<EvaluationCase>[] = [
    {
      id: 'case',
      header: 'Case',
      cell: (item) => (
        <>
          <strong>{item.title}</strong>
          <br />
          <small className="mono muted">{item.id}</small>
        </>
      ),
      sortValue: (item) => item.title,
    },
    { id: 'mode', header: 'Mode', cell: (item) => humaniseEnum(item.mode) },
    {
      id: 'tags',
      header: 'Tags',
      cell: (item) => (
        <span className="ds-choice-chips">
          {item.tags.map((tag) => (
            <span key={tag} className="ds-chip">
              {tag}
            </span>
          ))}
        </span>
      ),
      priority: 'low',
    },
    {
      id: 'turns',
      header: 'Turns',
      cell: (item) => item.turns.length,
      sortValue: (item) => item.turns.length,
      align: 'end',
    },
  ];
  return (
    <DataTableV2
      label="Evaluation dataset cases"
      rows={cases}
      columns={columns}
      rowKey={(item) => item.id}
      empty="No cases in this version."
    />
  );
}
