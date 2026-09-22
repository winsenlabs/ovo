'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, type SessionIdentity } from '../../lib/api';
import {
  createTeamUserPayload,
  teamRoleLabel,
  type TeamRole,
  type TeamUser,
  updateTeamUserPayload,
  USER_PASSWORD_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
  userManagementErrorMessage,
  userUpdateInvalidatesCurrentSession,
} from '../../lib/user-contract';
import {
  EmptyState,
  Field,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

const failureMessage = (failure: unknown, fallback: string) =>
  failure instanceof ApiError
    ? userManagementErrorMessage(failure.code, failure.message, fallback)
    : failure instanceof Error
      ? failure.message
      : fallback;

export function TeamView({
  identity,
  onSessionRevoked,
}: {
  identity: SessionIdentity;
  onSessionRevoked(reason: string): void;
}) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(identity.role === 'admin');
  const [unavailable, setUnavailable] = useState(false);
  const [editing, setEditing] = useState<TeamUser>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const createPassword = useRef<HTMLInputElement>(null);
  const resetPassword = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiRequest<{ items: TeamUser[] }>('/users');
      setUsers(data.items);
      setUnavailable(false);
      setError(undefined);
    } catch (failure) {
      setUnavailable(
        failure instanceof ApiError &&
          failure.status === 503 &&
          failure.code === 'user_management_unavailable',
      );
      setError(failureMessage(failure, 'Team users could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (identity.role === 'admin') void load();
  }, [identity.role, load]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const payload = createTeamUserPayload({
      email: String(values.get('email') ?? ''),
      label: String(values.get('label') ?? ''),
      role: String(values.get('role')) as TeamRole,
      password: String(values.get('password') ?? ''),
    });
    if (createPassword.current) createPassword.current.value = '';
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { data } = await apiRequest<TeamUser>('/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      form.reset();
      setNotice(`${data.label} was added as ${teamRoleLabel(data.role)}.`);
      await load();
    } catch (failure) {
      setError(failureMessage(failure, 'The user could not be added.'));
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const values = new FormData(event.currentTarget);
    const payload = updateTeamUserPayload({
      label: String(values.get('label') ?? ''),
      role: String(values.get('role')) as TeamRole,
      disabled: values.get('disabled') === 'on',
      password: String(values.get('password') ?? ''),
    });
    if (resetPassword.current) resetPassword.current.value = '';
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { data } = await apiRequest<TeamUser>(`/users/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setEditing(undefined);
      if (userUpdateInvalidatesCurrentSession(data.id, identity.id)) {
        onSessionRevoked('Your user account was updated. Sign in again to continue.');
        return;
      }
      setNotice(`${data.label} was updated. Their existing sessions ended.`);
      await load();
    } catch (failure) {
      setError(failureMessage(failure, 'The user could not be updated.'));
    } finally {
      setBusy(false);
    }
  }

  if (identity.role !== 'admin')
    return (
      <Notice tone="danger">
        Team administration is available only to administrators of this organization.
      </Notice>
    );

  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Team</h1>
          <p className="muted">
            Manage the users of this one organization. There are no invitations, tenant roles, or
            role hierarchy beyond Admin and User.
          </p>
        </div>
        <StatusBadge tone={unavailable ? 'warning' : 'soft'}>
          {unavailable ? 'Unavailable' : `${users.length} users`}
        </StatusBadge>
      </header>

      {error && (
        <Notice tone={unavailable ? 'warning' : 'danger'} live>
          {error}
        </Notice>
      )}
      {notice && <Notice live>{notice}</Notice>}

      {!unavailable && (
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
      )}

      {editing && !unavailable && (
        <Panel labelledBy="team-edit-title">
          <PanelHeader id="team-edit-title" title={`Edit ${editing.label}`}>
            <p className="muted">{editing.email}</p>
          </PanelHeader>
          <form key={editing.id} className="panel-body stack" onSubmit={updateUser}>
            <div className="form-grid">
              <Field label="Display name" htmlFor="team-edit-label">
                <input
                  id="team-edit-label"
                  name="label"
                  defaultValue={editing.label}
                  maxLength={120}
                  required
                />
              </Field>
              <Field label="Role" htmlFor="team-edit-role">
                <select id="team-edit-role" name="role" defaultValue={editing.role} required>
                  <option value="admin">Admin</option>
                  <option value="editor">User</option>
                </select>
              </Field>
              <Field
                label="Reset password"
                htmlFor="team-edit-password"
                help="Leave blank to keep it. To recover a restored user, set a fresh password while enabling the account."
              >
                <input
                  ref={resetPassword}
                  id="team-edit-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={USER_PASSWORD_MIN_LENGTH}
                  maxLength={USER_PASSWORD_MAX_LENGTH}
                />
              </Field>
              <label className="toggle-row" htmlFor="team-edit-disabled">
                <input
                  id="team-edit-disabled"
                  name="disabled"
                  type="checkbox"
                  defaultChecked={editing.disabled}
                />
                <span>
                  <strong>Disable this user</strong>
                  <small>Disabled users cannot sign in. The last active admin is protected.</small>
                </span>
              </label>
            </div>
            <div className="button-row">
              <button className="button primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save user'}
              </button>
              <button className="button" type="button" onClick={() => setEditing(undefined)}>
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      )}

      <Panel labelledBy="team-users-title">
        <PanelHeader id="team-users-title" title="Users" />
        <div className="panel-body">
          {loading ? (
            <LoadingBlock label="Loading team" />
          ) : !users.length && !unavailable ? (
            <EmptyState title="No users returned">
              Seed the first administrator on the server before managing this organization.
            </EmptyState>
          ) : users.length ? (
            <ResponsiveTable label="Organization users">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.label}</strong>
                      <small>{user.email}</small>
                      {user.id === identity.id && <small>You</small>}
                    </td>
                    <td>{teamRoleLabel(user.role)}</td>
                    <td>
                      <StatusBadge tone={user.disabled ? 'warning' : 'good'}>
                        {user.disabled ? 'Disabled' : 'Active'}
                      </StatusBadge>
                    </td>
                    <td>{new Date(user.updatedAt).toLocaleString()}</td>
                    <td>
                      <button
                        className="button small"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (resetPassword.current) resetPassword.current.value = '';
                          setEditing(user);
                          setError(undefined);
                          setNotice(undefined);
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
