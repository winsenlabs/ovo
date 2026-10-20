'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Drawer } from '../../components/ui/drawer';
import { InlineAlert } from '../../components/ui/feedback-v2';
import { queuesApi } from '../../lib/data/queues-api';
import type { OperatorRow } from '../../lib/types/queues';
import { NumberField, SelectField, SwitchField, TagsField, TextField } from '../../components/routing/fields';

export interface UserOption {
  id: string;
  label: string;
  email: string;
}

const BLANK: Omit<OperatorRow, 'status' | 'active'> = {
  userId: '',
  displayName: '',
  enabled: true,
  teamIds: [],
  languages: [],
  capacity: 1,
};

/** Add or edit an operator profile: which user, which teams and languages, how many calls at once. */
export function OperatorDrawer({
  open,
  operator,
  users,
  onClose,
  onSaved,
}: {
  open: boolean;
  operator?: OperatorRow;
  users: readonly UserOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(operator ? { ...operator } : BLANK);
      setError(undefined);
    }
  }, [open, operator]);
  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await queuesApi.saveOperator(draft.userId, draft);
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The operator could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      open={open}
      title={operator ? `Edit ${operator.displayName}` : 'Add operator'}
      onClose={onClose}
    >
      <form className="queue-form" onSubmit={save}>
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        {operator ? (
          <p className="muted">
            {operator.label ?? operator.userId}
            {operator.email && ` (${operator.email})`}
          </p>
        ) : (
          <SelectField
            id="operator-user"
            label="Team member"
            value={draft.userId}
            placeholder="Choose a person…"
            options={users.map((user) => ({
              value: user.id,
              label: `${user.label} (${user.email})`,
            }))}
            help="Operators are existing team members. Add people under Team first."
            onChange={(userId) => {
              const user = users.find((candidate) => candidate.id === userId);
              setDraft((current) => ({
                ...current,
                userId,
                displayName: current.displayName || user?.label || '',
              }));
            }}
          />
        )}
        <TextField
          id="operator-name"
          label="Name shown to callers' colleagues"
          value={draft.displayName}
          onChange={(v) => set('displayName', v)}
        />
        <TagsField
          id="operator-teams"
          label="Teams"
          values={draft.teamIds}
          placeholder="support"
          onChange={(v) => set('teamIds', v)}
        />
        <TagsField
          id="operator-languages"
          label="Languages spoken"
          values={draft.languages}
          placeholder="en"
          onChange={(v) => set('languages', v)}
        />
        <NumberField
          id="operator-capacity"
          label="Calls at once"
          min={0}
          max={20}
          help="0 keeps the profile but offers no calls."
          value={draft.capacity}
          onChange={(v) => set('capacity', v)}
        />
        <SwitchField
          label="Can answer calls"
          checked={draft.enabled}
          onChange={(v) => set('enabled', v)}
        />
        <div className="button-row queue-form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || !draft.userId}>
            {busy ? 'Saving…' : 'Save operator'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
