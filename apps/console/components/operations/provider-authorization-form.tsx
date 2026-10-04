'use client';
import type { FormEvent } from 'react';
import { Field } from '../primitives';
import type { Release } from '../../lib/api';
type ReleaseOption = Release & { agentName: string };
export function ProviderAuthorizationForm({
  releases,
  busy,
  create,
}: {
  releases: ReleaseOption[];
  busy: boolean;
  create: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form className="nested-card stack" onSubmit={create}>
      <strong>Create durable authorization</strong>
      <div className="form-grid">
        <Field label="Immutable release" htmlFor="provider-authorization-release">
          <select id="provider-authorization-release" name="releaseId" required>
            <option value="">Select immutable release</option>
            {releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.agentName} · {release.id}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Maximum reservation (paise)"
          htmlFor="provider-authorization-maximum"
          help="The immutable release reservation must remain at or below this positive cap."
        >
          <input
            id="provider-authorization-maximum"
            name="maximumReservationPaise"
            inputMode="numeric"
            pattern="[1-9][0-9]{0,59}"
            placeholder="5000"
            required
          />
        </Field>
      </div>
      <button className="button primary align-start" disabled={busy || releases.length === 0}>
        {busy ? 'Creating…' : 'Create authorization'}
      </button>
    </form>
  );
}
