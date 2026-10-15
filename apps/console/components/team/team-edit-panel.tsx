'use client';
import type { FormEvent, RefObject } from 'react';
import { FormField } from '../ui/form-field';
import {
  USER_PASSWORD_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
  type TeamUser,
} from '../../lib/user-contract';

/** The "Edit user" form, rendered inside a `Drawer` opened from a row's Edit action. */
export function TeamEditPanel({
  user,
  updateUser,
  resetPassword,
  busy,
  onCancel,
}: {
  user: TeamUser;
  updateUser: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  resetPassword: RefObject<HTMLInputElement | null>;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <form key={user.id} className="stack" onSubmit={updateUser}>
      <p className="muted">{user.email}</p>
      <FormField id="team-edit-label" label="Display name">
        {(control) => (
          <input {...control} name="label" defaultValue={user.label} maxLength={120} required />
        )}
      </FormField>
      <FormField id="team-edit-role" label="Role">
        {(control) => (
          <select {...control} name="role" defaultValue={user.role} required>
            <option value="admin">Admin</option>
            <option value="editor">User</option>
          </select>
        )}
      </FormField>
      <FormField
        id="team-edit-password"
        label="Reset password"
        help="Leave blank to keep it. To recover a restored user, set a fresh password while enabling the account."
      >
        {(control) => (
          <input
            {...control}
            ref={resetPassword}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={USER_PASSWORD_MIN_LENGTH}
            maxLength={USER_PASSWORD_MAX_LENGTH}
          />
        )}
      </FormField>
      <label className="toggle-row" htmlFor="team-edit-disabled">
        <input
          id="team-edit-disabled"
          name="disabled"
          type="checkbox"
          defaultChecked={user.disabled}
        />
        <span>
          <strong>Disable this user</strong>
          <small>Disabled users cannot sign in. The last active admin is protected.</small>
        </span>
      </label>
      <div className="button-row">
        <button className="button primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save user'}
        </button>
        <button className="button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
