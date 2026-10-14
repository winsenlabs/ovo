'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { EmptyStateV2, ErrorState, SkeletonTableRows } from '../ui/feedback-v2';

/**
 * Local fork of `components/ui/data-table-v2.tsx`.
 *
 * FOUNDATION BUG (see the report's "Foundation requests"): the shared `DataTableV2` calls
 * `useRef`/`useEffect` *after* three early `return`s (error/loading/empty), so the hook count
 * changes the moment a table goes from loading to populated — React throws "Rendered more hooks
 * than during the previous render" (minified error #310) on every real page load. This settings
 * screen is the first caller of `DataTableV2` anywhere in the app, which is why nothing had
 * tripped it yet; every other lane will hit the same crash the moment their tables render data.
 * Per the brief ("do not edit the design system; build a local one and list it as a foundation
 * request"), this is an exact copy with only the hook order corrected — no behaviour, prop or
 * className changes — so it can be deleted in favour of the shared one the moment it is fixed
 * upstream.
 */
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
  // Every hook the render can possibly need is called unconditionally, before any early return.
  const allSelected = Boolean(
    selected && rows.length > 0 && rows.every((row) => selected.has(rowKey(row))),
  );
  const someSelected = Boolean(selected && selected.size > 0 && !allSelected);
  const selectAllRef = useRef<HTMLInputElement>(null);
  // `indeterminate` is a DOM property, not an HTML attribute React exposes as a prop; it must be
  // set imperatively or a partial selection renders as a plain unchecked "select all" box.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
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
                  checked={allSelected}
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
