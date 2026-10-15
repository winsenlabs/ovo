'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { EmptyStateV2, ErrorState, Skeleton } from '../ui/feedback-v2';

export type ChartTableColumn = { header: string; cell: (rowIndex: number) => ReactNode };

/**
 * Shared chart shell: title, legend, a Chart/Table toggle (every chart must offer one — brief
 * acceptance checklist), loading/empty/error states, and a `ResizeObserver`-driven width so SVG
 * charts can lay out without a charting library. `renderChart` receives the measured width.
 */
export function ChartFrame({
  title,
  legend,
  ariaLabel,
  height = 220,
  loading = false,
  error,
  onRetry,
  empty = false,
  emptyLabel = 'No data in this range',
  tableRows,
  tableColumns,
  renderChart,
}: {
  title?: string;
  legend?: ReactNode;
  ariaLabel: string;
  height?: number;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  empty?: boolean;
  emptyLabel?: string;
  tableRows?: number;
  tableColumns?: readonly ChartTableColumn[];
  renderChart: (width: number) => ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  // A plain `useRef` only ever sees the element from the render where loading/empty/error was
  // false for the first time: those states skip mounting the measured div entirely, and a `[]`
  // effect never re-subscribes once it is finally rendered (brief defect #2 — a chart stuck at
  // 600px after a loading→ready or Table→Chart transition). A state-backed callback ref re-runs
  // this effect every time the node itself actually changes, including re-mounts.
  const setRef = (element: HTMLDivElement | null) => setNode(element);
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(next);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width || 600);
    return () => observer.disconnect();
  }, [node]);

  return (
    <div className="ds-chart-frame">
      <div className="ds-chart-frame-head">
        {title && <h3>{title}</h3>}
        <div className="ds-chart-frame-controls">
          {legend}
          {tableColumns && tableRows != null && (
            <div className="ds-chart-toggle" role="radiogroup" aria-label="Chart or table view">
              <button
                type="button"
                aria-checked={view === 'chart'}
                role="radio"
                className={view === 'chart' ? 'selected' : ''}
                onClick={() => setView('chart')}
              >
                Chart
              </button>
              <button
                type="button"
                aria-checked={view === 'table'}
                role="radio"
                className={view === 'table' ? 'selected' : ''}
                onClick={() => setView('table')}
              >
                Table
              </button>
            </div>
          )}
        </div>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading ? (
        <Skeleton shape="chart" width="100%" />
      ) : empty ? (
        <EmptyStateV2 variant="first-run" title={emptyLabel} />
      ) : view === 'table' && tableColumns ? (
        <div className="ds-table" role="region" aria-label={`${ariaLabel} as a table`} tabIndex={0}>
          <table>
            <thead>
              <tr>
                {tableColumns.map((column) => (
                  <th scope="col" key={column.header}>
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: tableRows ?? 0 }, (_, row) => (
                <tr key={row}>
                  {tableColumns.map((column) => (
                    // `data-label` drives the `.ds-table` stacked-card layout on phones, the same
                    // way DataTableV2 does; without it the Table view showed bare values.
                    <td key={column.header} data-label={column.header}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // `minHeight`, not `height`: the measured box clips horizontally (see ds-charts.css), and a
        // fixed height also clipped any chart whose own content runs taller than `height` — a
        // Donut renders its legend inside this box, so every slice past the first two vanished.
        <div ref={setRef} role="img" aria-label={ariaLabel} style={{ minHeight: height }}>
          {renderChart(width)}
        </div>
      )}
    </div>
  );
}
