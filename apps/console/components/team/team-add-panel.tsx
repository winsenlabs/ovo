'use client';
import type { FormEvent, RefObject } from 'react';
import { FormField } from '../ui/form-field';
import { USER_PASSWORD_MAX_LENGTH, USER_PASSWORD_MIN_LENGTH } from '../../lib/user-contract';

/**
 * The "Add user" form, rendered inside a `Drawer` from the Team page header (brief defect:
 * create-forms belong in drawers, never above the data they create).
 */
export function TeamAddPanel({
  createUser,
  createPassword,
  busy,
}: {
  createUser: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  createPassword: RefObject<HTMLInputElement | null>;
  busy: boolean;
}) {
  return (
    <form className="stack" onSubmit={createUser}>
      <p className="muted">
        Create an account directly; this installation does not send invitations.
      </p>
      <FormField id="team-create-email" label="Email">
        {(control) => (
          <input
            {...control}
            name="email"
            type="email"
            autoComplete="off"
            maxLength={254}
            required
            spellCheck={false}
          />
        )}
      </FormField>
      <FormField id="team-create-label" label="Display name">
        {(control) => (
          <input {...control} name="label" autoComplete="off" maxLength={120} required />
        )}
      </FormField>
      <FormField id="team-create-role" label="Role">
        {(control) => (
          <select {...control} name="role" defaultValue="editor" required>
            <option value="admin">Admin</option>
            <option value="editor">User</option>
          </select>
        )}
      </FormField>
      <FormField
        id="team-create-password"
        label="Initial password"
        help={`${USER_PASSWORD_MIN_LENGTH}–${USER_PASSWORD_MAX_LENGTH} characters. Share it outside OVO.`}
      >
        {(control) => (
          <input
            {...control}
            ref={createPassword}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={USER_PASSWORD_MIN_LENGTH}
            maxLength={USER_PASSWORD_MAX_LENGTH}
            required
          />
        )}
      </FormField>
      <button className="button primary" disabled={busy}>
        {busy ? 'Adding user…' : 'Add user'}
      </button>
    </form>
  );
}
