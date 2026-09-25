'use client';
import type { RefObject } from 'react';
import type { SessionIdentity } from '../../lib/api';
import { teamRoleLabel, type TeamUser } from '../../lib/user-contract';
import { ResponsiveTable, StatusBadge } from '../primitives';
export function TeamUsersTable({
  users,
  identity,
  busy,
  resetPassword,
  setEditing,
  setError,
  setNotice,
}: {
  users: TeamUser[];
  identity: SessionIdentity;
  busy: boolean;
  resetPassword: RefObject<HTMLInputElement | null>;
  setEditing: (user: TeamUser) => void;
  setError: (value?: string) => void;
  setNotice: (value?: string) => void;
}) {
  return (
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
  );
}
