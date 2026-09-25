export function Pagination({ previous, next, onPrevious, onNext, busy = false }: {
  previous: boolean; next: boolean; onPrevious: () => void; onNext: () => void; busy?: boolean;
}) {
  return <nav className="ui-pagination" aria-label="Pagination">
    <button type="button" className="button" disabled={!previous || busy} onClick={onPrevious}>Previous</button>
    <button type="button" className="button" disabled={!next || busy} onClick={onNext}>Next</button>
  </nav>;
}
