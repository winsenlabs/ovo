'use client';
import { useEffect, useState } from 'react';
import type { CredentialMetadata } from '../../lib/api';
import { Dialog } from '../ui/dialog';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';

/** Rotate flow: one write-only field, no reveal, no per-row secret input in the table itself
 * (brief defect #23 — every credential row used to carry a live secret input). */
export function RotateDialog({
  credential,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  credential: CredentialMetadata | undefined;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (credential: CredentialMetadata, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (credential) setValue('');
  }, [credential]);
  if (!credential) return null;
  return (
    <Dialog open title={`Rotate ${credential.label}`} onClose={onClose}>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <p className="muted">
        The new value replaces {credential.fingerprint ?? 'the current value'} for{' '}
        {credential.label}. It is never shown again once saved.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (value) void onSubmit(credential, value);
        }}
      >
        <FormField id="rotate-value" label="New value" required>
          {(props) => (
            <input
              {...props}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </FormField>
        <div className="ui-cluster">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || !value}>
            {busy ? 'Rotating…' : 'Rotate'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
