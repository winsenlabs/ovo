import type { DraftIssue } from '../../lib/derive/routing-anchor';

/** Issues placed on the part of the designer they concern. Severity is text, never colour alone. */
export function IssueList({
  issues,
  label = 'Problems',
}: {
  issues: readonly { issue: DraftIssue }[] | readonly DraftIssue[];
  label?: string;
}) {
  const list = (issues as readonly (DraftIssue | { issue: DraftIssue })[]).map((i) =>
    'issue' in i ? i.issue : i,
  );
  if (!list.length) return null;
  return (
    <ul className="rt-issues" aria-label={label}>
      {list.map((issue, index) => (
        <li
          key={`${issue.code}-${issue.path.join('.')}-${index}`}
          className={`rt-issue tone-${issue.severity === 'error' ? 'danger' : 'warn'}`}
        >
          <strong>{issue.severity === 'error' ? 'Error' : 'Warning'}</strong>
          <span>{issue.message}</span>
          <code className="mono muted">{issue.code}</code>
        </li>
      ))}
    </ul>
  );
}

/** "2 errors, 1 warning" for tab titles and the header; empty when there is nothing to say. */
export function issueCountLabel(errors: number, warnings: number): string {
  const parts = [
    errors ? `${errors} error${errors === 1 ? '' : 's'}` : '',
    warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}
