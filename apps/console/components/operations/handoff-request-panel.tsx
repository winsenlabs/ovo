'use client';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { CallSummary, SessionIdentity } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { Duration } from '../ui/display';

/** How long a live call has been running, from its creation instant. */
function liveDuration(call: CallSummary): number | undefined {
  return call.createdAt ? Date.now() - new Date(call.createdAt).getTime() : undefined;
}

export function HandoffRequestPanel({
  call,
  targetKind,
  setTargetKind,
  fallbackKind,
  setFallbackKind,
  role,
  busy,
  create,
  onCancel,
}: {
  call: CallSummary;
  targetKind: 'phone' | 'queue';
  setTargetKind: Dispatch<SetStateAction<'phone' | 'queue'>>;
  fallbackKind: 'resume' | 'end' | 'human';
  setFallbackKind: Dispatch<SetStateAction<'resume' | 'end' | 'human'>>;
  role: SessionIdentity['role'];
  busy: boolean;
  create: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <form className="stack" onSubmit={create}>
      <p className="muted">
        Call <span className="mono">{call.id}</span> · running <Duration ms={liveDuration(call)} />
      </p>
      <input type="hidden" name="callId" value={call.id} />
      <FormField id="handoff-target-kind" label="Target type">
        {(control) => (
          <select
            {...control}
            value={targetKind}
            onChange={(event) => setTargetKind(event.target.value as 'phone' | 'queue')}
          >
            <option value="phone">Phone</option>
            <option value="queue">Queue</option>
          </select>
        )}
      </FormField>
      <FormField
        id="handoff-target"
        label={targetKind === 'phone' ? 'Target E.164 number' : 'Queue identifier'}
      >
        {(control) => (
          <input
            {...control}
            name="target"
            required
            placeholder={targetKind === 'phone' ? '+91…' : 'support-tier-2'}
          />
        )}
      </FormField>
      <FormField id="handoff-fallback-kind" label="Failure fallback">
        {(control) => (
          <select
            {...control}
            value={fallbackKind}
            onChange={(event) => setFallbackKind(event.target.value as typeof fallbackKind)}
          >
            <option value="resume">Resume agent</option>
            <option value="end">End call</option>
            <option value="human">Alternate human target</option>
          </select>
        )}
      </FormField>
      {fallbackKind === 'human' && (
        <FormField id="handoff-fallback-target" label="Fallback target">
          {(control) => <input {...control} name="fallbackTarget" required />}
        </FormField>
      )}
      <FormField id="handoff-fallback-message" label="Fallback caller message">
        {(control) => <textarea {...control} name="fallbackMessage" required />}
      </FormField>
      <label className="toggle-row">
        <input type="checkbox" name="confirmationRequired" defaultChecked />
        <span>
          <strong>Require explicit operator confirmation</strong>
          <small>The provider request starts only after acceptance.</small>
        </span>
      </label>
      <div className="button-row">
        <button className="button primary" disabled={role === 'viewer' || busy}>
          {busy ? 'Submitting…' : 'Request handoff'}
        </button>
        <button className="button" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
