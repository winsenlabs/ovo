'use client';
import type { RefObject } from 'react';
import type { SessionIdentity } from '../../lib/api';
import { teamRoleLabel, type TeamUser } from '../../lib/user-contract';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { RelativeTime } from '../ui/display';

export function TeamUsersTable({
  users,
  identity,
  busy,
  resetPassword,
  setEditing,
  setError,
  setNotice,
}: {
  users: readonly TeamUser[];
  identity: SessionIdentity;
  busy: boolean;
  resetPassword: RefObject<HTMLInputElement | null>;
  setEditing: (user: TeamUser) => void;
  setError: (value?: string) => void;
  setNotice: (value?: string) => void;
}) {
  const edit = (user: TeamUser) => {
    if (resetPassword.current) resetPassword.current.value = '';
    setEditing(user);
    setError(undefined);
    setNotice(undefined);
  };
  const columns: readonly ColumnV2<TeamUser>[] = [
    {
      id: 'user',
      header: 'User',
      priority: 'high',
      sortValue: (user) => user.label.toLowerCase(),
      cell: (user) => (
        <button type="button" className="team-user-cell" onClick={() => edit(user)}>
          <span className="sidebar-profile-avatar" aria-hidden="true">
            {user.label.charAt(0).toUpperCase()}
          </span>
          <span className="team-user-cell-text">
            <strong>
              {user.label}
              {user.id === identity.id && <span className="ds-chip ds-chip-you">You</span>}
            </strong>
            <small className="muted">{user.email}</small>
          </span>
        </button>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (user) => user.role,
      cell: (user) => teamRoleLabel(user.role),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (user) => (user.disabled ? 1 : 0),
      cell: (user) => <StatusBadgeV2 value={user.disabled ? 'disabled' : 'active'} />,
    },
    {
      id: 'updated',
      header: 'Updated',
      priority: 'low',
      sortValue: (user) => user.updatedAt,
      cell: (user) => <RelativeTime value={user.updatedAt} />,
    },
    {
      id: 'action',
      header: '',
      align: 'end',
      cell: (user) => (
        <button className="button" type="button" disabled={busy} onClick={() => edit(user)}>
          Edit
        </button>
      ),
    },
  ];
  return (
    <DataTableV2
      label="Organization users"
      rows={users}
      columns={columns}
      rowKey={(user) => user.id}
      empty="No users match this search"
    />
  );
}
