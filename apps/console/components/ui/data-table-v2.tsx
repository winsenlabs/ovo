'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { SkeletonTableRows } from './feedback-v2';
import { EmptyStateV2, ErrorState } from './feedback-v2';

export type ColumnV2<T> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: 'start' | 'end';
  width?: string;
  sortValue?: (row: T) => string | number;
  priority?: 'high' | 'normal' | 'low';
};

type SortState = { column: string; direction: 'asc' | 'desc' } | null;

function sortRows<T>(rows: readonly T[], columns: readonly ColumnV2<T>[], sort: SortState): T[] {
  if (!sort) return [...rows];
  const column = columns.find((c) => c.id === sort.column);
  if (!column?.sortValue) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = column.sortValue!(a);
    const right = column.sortValue!(b);
    return left < right ? -sign : left > right ? sign : 0;
  });
}

/**
 * The one data table. Client sort via `aria-sort`, optional row link (whole row clickable and
 * keyboard-focusable), optional checkbox selection, sticky header, and honest loading/empty/error
 * states. On narrow viewports the caller's CSS (`.ds-table`) turns rows into stacked cards; pass
 * `mobilePrimary`/`mobileSecondary` to control which columns stay visible there.
 */
export function DataTableV2<T>({
  label,
  rows,
  columns,
  rowKey,
  rowHref,
  empty,
  loading = false,
  error,
  onRetry,
  selected,
  onSelectChange,
  density = 'normal',
}: {
  label: string;
  rows: readonly T[];
  columns: readonly ColumnV2<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string | undefined;
  empty?: ReactNode;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  selected?: ReadonlySet<string>;
  onSelectChange?: (keys: ReadonlySet<string>) => void;
  density?: 'normal' | 'compact';
}) {
  const [sort, setSort] = useState<SortState>(null);
  // Every hook in this component must run on every render, in the same order, regardless of
  // which branch below ends up returning — the error/loading/empty early returns used to sit
  // ahead of `useRef`/`useEffect`, so switching between those states and the table (e.g. a
  // retry, or data arriving) changed how many hooks had run and could desync React's hook state.
  const allSelected = selected && rows.length > 0 && rows.every((row) => selected.has(rowKey(row)));
  const someSelected = selected && selected.size > 0 && !allSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);
  // `indeterminate` is a DOM property, not an HTML attribute React exposes as a prop; it must be
  // set imperatively or a partial selection renders as a plain unchecked "select all" box.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = Boolean(someSelected);
  }, [someSelected]);

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (loading) return <SkeletonTableRows columns={columns.length} />;
  if (!rows.length)
    return typeof empty === 'string' ? (
      <EmptyStateV2 title={empty} />
    ) : (
      (empty ?? <EmptyStateV2 title="No results" />)
    );

  const sorted = sortRows(rows, columns, sort);
  const toggleSort = (column: ColumnV2<T>) => {
    if (!column.sortValue) return;
    setSort((previous) =>
      previous?.column === column.id
        ? { column: column.id, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
        : { column: column.id, direction: 'asc' },
    );
  };

  return (
    <div className={`ds-table density-${density}`} role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {onSelectChange && (
              <th scope="col" className="ds-table-select">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={Boolean(allSelected)}
                  onChange={(event) =>
                    onSelectChange(event.target.checked ? new Set(rows.map(rowKey)) : new Set())
                  }
                />
              </th>
            )}
            {columns.map((column) => (
              <th
                scope="col"
                key={column.id}
                className={`priority-${column.priority ?? 'normal'} align-${column.align ?? 'start'}`}
                style={column.width ? { width: column.width } : undefined}
                aria-sort={
                  sort?.column === column.id
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
              >
                {column.sortValue ? (
                  <button
                    type="button"
                    className="ds-sort-button"
                    onClick={() => toggleSort(column)}
                  >
                    {column.header}
                    <span aria-hidden="true">
                      {sort?.column === column.id ? (sort.direction === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const href = rowHref?.(row);
            return (
              <tr key={key} className={href ? 'ds-row-link' : undefined}>
                {onSelectChange && (
                  <td className="ds-table-select">
                    <input
                      type="checkbox"
                      aria-label={`Select row ${key}`}
                      checked={selected?.has(key) ?? false}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(key);
                        else next.delete(key);
                        onSelectChange(next);
                      }}
                    />
                  </td>
                )}
                {columns.map((column, index) => (
                  <td
                    key={column.id}
                    data-label={column.header}
                    className={`priority-${column.priority ?? 'normal'} align-${column.align ?? 'start'}`}
                  >
                    {href && index === 0 ? (
                      <Link href={href} className="ds-row-link-anchor">
                        {column.cell(row)}
                      </Link>
                    ) : (
                      column.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
