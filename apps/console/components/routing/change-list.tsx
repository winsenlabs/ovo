import { groupChanges } from '../../lib/derive/routing-diff';
import type { RoutingChange } from '../../lib/types/routing';

/** A diff as sentences, grouped by area (the publish drawer and the release comparison share it). */
export function ChangeList({ changes, empty = 'No differences.' }: { changes: readonly RoutingChange[]; empty?: string }) {
  const groups = groupChanges(changes);
  if (!groups.length) return <p className="muted">{empty}</p>;
  return (
    <div className="rt-changes">
      {groups.map((group) => (
        <section key={group.area} aria-label={group.label}>
          <h4>
            {group.label} <span className="muted">({group.items.length})</span>
          </h4>
          <ul>
            {group.items.map((change, i) => (
              <li key={`${change.key}-${i}`} className={`rt-change op-${change.op}`}>
                <span className="rt-change-op">{change.op === 'added' ? 'Added' : change.op === 'removed' ? 'Removed' : 'Changed'}</span>
                {change.summary}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
