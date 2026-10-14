'use client';
import { useState } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { FileDrop } from '../ui/inputs';
import { InlineAlert } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';

/** The API's per-request limit (MAX_DO_NOT_CALL_IMPORT). */
export const IMPORT_LIMIT = 1000;

/**
 * Phone numbers from pasted text or a CSV: the first cell of each line, with a header line and
 * blank lines skipped. Duplicates collapse; the server normalizes and validates each number.
 */
export function parseDoNotCallNumbers(text: string): string[] {
  const numbers = text
    .split(/\r?\n/)
    .map((line) => line.split(',')[0]!.trim().replace(/^"|"$/g, ''))
    .filter((cell) => cell && /\d/.test(cell));
  return [...new Set(numbers)];
}

/**
 * Bulk import of a do-not-call registry or a client's opt-out export, 1,000 numbers per request.
 * Lives inside a drawer opened from the list's "Import" action.
 */
export function DoNotCallImport({
  role,
  onImported,
}: {
  role: SessionIdentity['role'];
  onImported: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string }>();
  const numbers = parseDoNotCallNumbers(text);
  async function importNumbers() {
    setBusy(true);
    setMessage(undefined);
    let added = 0;
    let updated = 0;
    try {
      for (let start = 0; start < numbers.length; start += IMPORT_LIMIT) {
        const { data } = await apiRequest<{ added: number; updated: number }>(
          '/operations/suppressions/import',
          {
            method: 'POST',
            body: JSON.stringify({
              entries: numbers
                .slice(start, start + IMPORT_LIMIT)
                .map((phoneNumber) => ({ phoneNumber, reason: note.trim() })),
            }),
          },
        );
        added += data.added;
        updated += data.updated;
      }
      setMessage({ tone: 'info', text: `${added} added, ${updated} already listed.` });
      setText('');
      await onImported();
    } catch (failure) {
      setMessage({
        tone: 'danger',
        text: `${failure instanceof Error ? failure.message : 'Import failed.'}${added + updated ? ` ${added + updated} numbers were saved before the failure.` : ''}`,
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <StatusBadgeV2 tone="neutral" label={`${numbers.length} ready`} />
      <FormField
        id="dnc-import-numbers"
        label="Numbers, one per line or a CSV"
        help="The first column of each line, in E.164 (+91…). A header line is skipped."
      >
        {(control) => (
          <textarea
            {...control}
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </FormField>
      <FileDrop
        accept=".csv,.txt,text/csv,text/plain"
        hint="Or drop a CSV / text file here"
        onFile={(file) => void file.text().then(setText)}
      />
      <FormField id="dnc-import-note" label="Import note" help="Stored as each entry's reason.">
        {(control) => (
          <input
            {...control}
            maxLength={1000}
            placeholder="NCPR registry, October"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </FormField>
      <button
        className="button primary align-start"
        type="button"
        disabled={role === 'viewer' || busy || !numbers.length || !note.trim()}
        onClick={() => void importNumbers()}
      >
        {busy
          ? 'Importing…'
          : numbers.length
            ? `Import ${numbers.length} numbers`
            : 'Import numbers'}
      </button>
      {message && <InlineAlert tone={message.tone}>{message.text}</InlineAlert>}
    </div>
  );
}
