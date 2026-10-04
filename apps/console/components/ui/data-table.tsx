import type { ReactNode } from 'react';
import { EmptyState } from './feedback';
export type Column<T> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  priority?: 'high' | 'normal' | 'low';
};
export function DataTable<T>({
  label,
  rows,
  columns,
  rowKey,
  empty = 'No results',
}: {
  label: string;
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <div className="ui-table" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.id} className={`priority-${column.priority ?? 'normal'}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.id}
                  data-label={column.header}
                  className={`priority-${column.priority ?? 'normal'}`}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
