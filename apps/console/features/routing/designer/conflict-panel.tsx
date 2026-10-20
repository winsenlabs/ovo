'use client';
import { ChangeList } from '../../../components/routing/change-list';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import type { Conflict } from './use-routing-draft';

/** The server's draft moved while the operator edited: what their edits change on top of it. */
export function ConflictPanel({
  conflict,
  onTakeTheirs,
  onKeepMine,
}: {
  conflict: Conflict;
  onTakeTheirs: () => void;
  onKeepMine: () => void;
}) {
  return (
    <InlineAlert tone="danger">
      <strong>This point changed on the server.</strong> Your edits were not saved and nothing was
      overwritten.
      <ChangeList
        changes={conflict.changes}
        empty="The server draft now matches yours; only its version moved."
      />
      <span className="button-row">
        <button type="button" className="button" onClick={onTakeTheirs}>
          Load the server draft (lose my edits)
        </button>
        <button type="button" className="button" onClick={onKeepMine}>
          Keep my edits and save over the server draft
        </button>
      </span>
    </InlineAlert>
  );
}
