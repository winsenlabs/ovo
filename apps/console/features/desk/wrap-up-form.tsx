'use client';
import { useState } from 'react';
import { Select } from '../../components/ui/inputs';
import type { DeskQueueInfo } from '../../lib/types/desk';

/** Disposition and note after the call; required before the next accept when the queue says so. */
export function WrapUpForm({
  queue,
  done,
  onSubmit,
  onSkip,
}: {
  queue: DeskQueueInfo | undefined;
  done: boolean;
  onSubmit: (wrap: { disposition?: string; note?: string }) => Promise<boolean>;
  onSkip: () => void;
}) {
  const [disposition, setDisposition] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const required = queue?.wrapUp.required ?? false;
  const dispositions = queue?.wrapUp.dispositions ?? [];
  if (done) return <p className="muted">Wrap-up saved.</p>;
  const invalid = required && dispositions.length > 0 && !disposition;
  return (
    <form
      className="desk-wrapup"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await onSubmit({
            ...(disposition ? { disposition } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Wrap-up{required ? ' (required)' : ''}</h3>
      {dispositions.length > 0 && (
        <div className="field">
          <label htmlFor="desk-disposition">Disposition</label>
          <Select
            id="desk-disposition"
            value={disposition}
            placeholder="Choose…"
            options={dispositions.map((value) => ({ value, label: value }))}
            onChange={setDisposition}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="desk-note">Note</label>
        <textarea
          id="desk-note"
          rows={3}
          maxLength={1000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <div className="button-row">
        <button type="submit" className="button primary" disabled={busy || invalid}>
          Save wrap-up
        </button>
        {!required && (
          <button type="button" className="button" onClick={onSkip}>
            Skip
          </button>
        )}
      </div>
    </form>
  );
}
