'use client';
import type { FormEvent, RefObject } from 'react';
import { USER_PASSWORD_MAX_LENGTH, USER_PASSWORD_MIN_LENGTH } from '../../lib/user-contract';
import { Field, Panel, PanelHeader } from '../primitives';
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
    <Panel labelledBy="team-add-title">
      <PanelHeader id="team-add-title" title="Add user">
        <p className="muted">
          Create an account directly; this installation does not send invitations.
        </p>
      </PanelHeader>
      <form className="panel-body stack" onSubmit={createUser}>
        <div className="form-grid">
          <Field label="Email" htmlFor="team-create-email">
            <input
              id="team-create-email"
              name="email"
              type="email"
              autoComplete="off"
              maxLength={254}
              required
              spellCheck={false}
            />
          </Field>
          <Field label="Display name" htmlFor="team-create-label">
            <input
              id="team-create-label"
              name="label"
              autoComplete="off"
              maxLength={120}
              required
            />
          </Field>
          <Field label="Role" htmlFor="team-create-role">
            <select id="team-create-role" name="role" defaultValue="editor" required>
              <option value="admin">Admin</option>
              <option value="editor">User</option>
            </select>
          </Field>
          <Field
            label="Initial password"
            htmlFor="team-create-password"
            help={`${USER_PASSWORD_MIN_LENGTH}–${USER_PASSWORD_MAX_LENGTH} characters. Share it outside OVO.`}
          >
            <input
              ref={createPassword}
              id="team-create-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={USER_PASSWORD_MIN_LENGTH}
              maxLength={USER_PASSWORD_MAX_LENGTH}
              required
            />
          </Field>
        </div>
        <button className="button primary align-start" disabled={busy}>
          {busy ? 'Adding user…' : 'Add user'}
        </button>
      </form>
    </Panel>
  );
}
