/** "1–50 of many" + Prev/Next; hidden entirely when there is a single page (brief defect #10). */
export function PaginationV2({
  from,
  to,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  busy = false,
}: {
  from: number;
  to: number;
  total?: number | 'many';
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  busy?: boolean;
}) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav className="ds-pagination" aria-label="Pagination">
      <span className="muted">
        {from}–{to} of {total ?? 'many'}
      </span>
      <div className="ds-pagination-buttons">
        <button
          type="button"
          className="button small"
          disabled={!hasPrevious || busy}
          onClick={onPrevious}
        >
          Previous
        </button>
        <button type="button" className="button small" disabled={!hasNext || busy} onClick={onNext}>
          Next
        </button>
      </div>
    </nav>
  );
}
