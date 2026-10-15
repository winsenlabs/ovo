'use client';
import { Dialog } from '../ui/dialog';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';
import { formatPhoneNumber } from '../../lib/format';

/**
 * The mandatory removal-reason prompt, scoped to the one row being removed (brief: the reason
 * field lives inside the confirm dialog, not a page-level field that gates every row at once).
 */
export function DoNotCallRemoveDialog({
  phoneNumber,
  reason,
  onReasonChange,
  error,
  busy,
  onConfirm,
  onClose,
}: {
  phoneNumber?: string;
  reason: string;
  onReasonChange: (value: string) => void;
  error?: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={phoneNumber !== undefined}
      onClose={onClose}
      title="Remove from the do-not-call list"
    >
      {phoneNumber && (
        <div className="stack">
          <p>
            Remove <span className="mono">{formatPhoneNumber(phoneNumber)}</span>? The number may
            become eligible immediately. This is recorded in the audit log.
          </p>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
          <FormField id="suppression-removal-reason" label="Reason for removal" required>
            {(control) => (
              <input
                {...control}
                value={reason}
                minLength={3}
                maxLength={1000}
                onChange={(event) => onReasonChange(event.target.value)}
              />
            )}
          </FormField>
          <div className="button-row">
            <button className="button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button danger"
              type="button"
              disabled={busy || reason.trim().length < 3}
              onClick={onConfirm}
            >
              Confirm removal
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
