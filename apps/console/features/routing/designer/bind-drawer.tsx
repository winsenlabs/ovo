'use client';
import { useEffect, useState } from 'react';
import { SelectField } from '../../../components/routing/fields';
import { Drawer } from '../../../components/ui/drawer';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { ApiError } from '../../../lib/api';
import { routingApi } from '../../../lib/data/routing-api';
import { formatPhoneNumber } from '../../../lib/format';
import { bindConsequence, modeLabel } from '../../../lib/derive/routing-numbers';
import type { NumberRow, ReleaseSummary } from '../../../lib/types/routing';

/** Bind a number to a release of this point, stating what changes for its callers first. */
export function BindDrawer({
  open,
  candidates,
  initial,
  releases,
  pointName,
  onClose,
  onBound,
}: {
  open: boolean;
  candidates: readonly NumberRow[];
  initial?: NumberRow;
  releases: readonly ReleaseSummary[];
  pointName: string;
  onClose: () => void;
  onBound: (message: string) => void;
}) {
  const [phone, setPhone] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const newest = releases.reduce<ReleaseSummary | undefined>((best, r) => (!best || r.version > best.version ? r : best), undefined);
  useEffect(() => {
    if (!open) return;
    setPhone(initial?.phoneNumber ?? '');
    setReleaseId(newest?.id ?? '');
    setConfirmed(false);
    setError(undefined);
  }, [open, initial, newest?.id]);
  const row = candidates.find((c) => c.phoneNumber === phone);
  const release = releases.find((r) => r.id === releaseId);
  const consequence = row && release ? bindConsequence(row, pointName, release.version) : undefined;
  async function bind() {
    if (!row || !release) return;
    setBusy(true);
    setError(undefined);
    try {
      await routingApi.bindNumber(row, { routingReleaseId: release.id });
      onBound(`${formatPhoneNumber(row.phoneNumber)} is now bound to ${pointName} version ${release.version}.`);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? 'The number changed while you were looking. Close this panel to see its latest state.'
          : failure instanceof Error ? failure.message : 'The number could not be bound.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer open={open} title="Bind a number" onClose={onClose}>
      <div className="queue-form">
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <SelectField
          id="bind-number"
          label="Number"
          value={phone}
          placeholder={candidates.length ? 'Choose a number…' : 'No numbers to bind'}
          options={candidates.map((c) => ({ value: c.phoneNumber, label: `${formatPhoneNumber(c.phoneNumber)} (${modeLabel(c)})` }))}
          onChange={setPhone}
        />
        <SelectField
          id="bind-release"
          label="Release"
          value={releaseId}
          placeholder={releases.length ? 'Choose a release…' : 'Publish a release first'}
          options={releases.map((r) => ({ value: r.id, label: `Version ${r.version}${r.id === newest?.id ? ' (latest)' : ''}` }))}
          onChange={setReleaseId}
        />
        {consequence && <InlineAlert tone="info">{consequence.text}</InlineAlert>}
        {consequence?.needsConfirm && (
          <label className="rt-confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I understand how callers are affected
          </label>
        )}
        <div className="button-row queue-form-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" disabled={!row || !release || busy || (consequence?.needsConfirm && !confirmed)} onClick={() => void bind()}>
            {busy ? 'Binding…' : 'Bind'}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
