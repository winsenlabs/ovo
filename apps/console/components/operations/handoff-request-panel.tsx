'use client';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { CallSummary, SessionIdentity } from '../../lib/api';
import { Field, Panel, PanelHeader, StatusBadge } from '../primitives';
export function HandoffRequestPanel({ calls, targetKind, setTargetKind, fallbackKind, setFallbackKind, role, busy, create }: {
  calls: CallSummary[]; targetKind: 'phone' | 'queue'; setTargetKind: Dispatch<SetStateAction<'phone' | 'queue'>>;
  fallbackKind: 'resume' | 'end' | 'human'; setFallbackKind: Dispatch<SetStateAction<'resume' | 'end' | 'human'>>;
  role: SessionIdentity['role']; busy: boolean; create: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
      <Panel labelledBy="handoff-request-title">
        <PanelHeader
          id="handoff-request-title"
          title="Request handoff"
          badge={<StatusBadge tone="warning">Live calls only</StatusBadge>}
        />
        <form className="panel-body stack" onSubmit={create}>
          {!calls.length && (
            <div className="muted">
              No active live calls with a verified carrier binding are visible. Simulation calls
              cannot be handed off.
            </div>
          )}
          <div className="form-grid">
            <Field label="Active live call" htmlFor="handoff-call">
              <select id="handoff-call" name="callId" required>
                <option value="">Select live call</option>
                {calls.map((call) => (
                  <option key={call.id} value={call.id}>
                    {call.id} · {call.status}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Target type" htmlFor="handoff-target-kind">
              <select
                id="handoff-target-kind"
                value={targetKind}
                onChange={(event) => setTargetKind(event.target.value as 'phone' | 'queue')}
              >
                <option value="phone">Phone</option>
                <option value="queue">Queue</option>
              </select>
            </Field>
            <Field
              label={targetKind === 'phone' ? 'Target E.164 number' : 'Queue identifier'}
              htmlFor="handoff-target"
            >
              <input
                id="handoff-target"
                name="target"
                required
                placeholder={targetKind === 'phone' ? '+91…' : 'support-tier-2'}
              />
            </Field>
            <Field label="Failure fallback" htmlFor="handoff-fallback-kind">
              <select
                id="handoff-fallback-kind"
                value={fallbackKind}
                onChange={(event) => setFallbackKind(event.target.value as typeof fallbackKind)}
              >
                <option value="resume">Resume agent</option>
                <option value="end">End call</option>
                <option value="human">Alternate human target</option>
              </select>
            </Field>
            {fallbackKind === 'human' && (
              <Field label="Fallback target" htmlFor="handoff-fallback-target">
                <input id="handoff-fallback-target" name="fallbackTarget" required />
              </Field>
            )}
            <Field label="Fallback caller message" htmlFor="handoff-fallback-message">
              <textarea id="handoff-fallback-message" name="fallbackMessage" required />
            </Field>
          </div>
          <label className="toggle-row">
            <input type="checkbox" name="confirmationRequired" defaultChecked />
            <span>
              <strong>Require explicit operator confirmation</strong>
              <small>The provider request starts only after acceptance.</small>
            </span>
          </label>
          <button
            className="button primary align-start"
            disabled={role === 'viewer' || busy || !calls.length}
          >
            {busy ? 'Submitting…' : 'Request handoff'}
          </button>
        </form>
      </Panel>
  );
}
