'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, type SessionIdentity } from '../../lib/api';
import {
  createTeamUserPayload,
  teamRoleLabel,
  type TeamRole,
  type TeamUser,
  updateTeamUserPayload,
  userManagementErrorMessage,
  userUpdateInvalidatesCurrentSession,
} from '../../lib/user-contract';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { Drawer } from '../ui/drawer';
import { EmptyStateV2, ErrorState, InlineAlert, SkeletonTableRows } from '../ui/feedback-v2';
import { TeamUsersTable } from './team-users-table';
import { TeamAddPanel } from './team-add-panel';
import { TeamEditPanel } from './team-edit-panel';

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
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
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
      setAddOpen(false);
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

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((user) => {
      if (term && !`${user.label} ${user.email}`.toLowerCase().includes(term)) return false;
      if (roleFilter && user.role !== roleFilter) return false;
      if (statusFilter === 'active' && user.disabled) return false;
      if (statusFilter === 'disabled' && !user.disabled) return false;
      return true;
    });
  }, [users, search, roleFilter, statusFilter]);

  const counts = useMemo(
    () => ({
      total: users.length,
      admins: users.filter((user) => user.role === 'admin').length,
      editors: users.filter((user) => user.role === 'editor').length,
      disabled: users.filter((user) => user.disabled).length,
    }),
    [users],
  );

  if (identity.role !== 'admin')
    return (
      <div className="stack">
        <PageHeader eyebrow="Settings" title="Team" />
        <InlineAlert tone="danger">
          Team administration is available only to administrators of this organization.
        </InlineAlert>
      </div>
    );

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Settings"
        title="Team"
        description="Manage the users of this one organization. There are no invitations, tenant roles, or role hierarchy beyond Admin and User."
        actions={
          !unavailable && (
            <button className="button primary" type="button" onClick={() => setAddOpen(true)}>
              Add user
            </button>
          )
        }
      />

      {!unavailable && (!error || counts.total > 0) && (
        <KpiStrip>
          <KpiCard
            label="Total users"
            value={loading ? undefined : counts.total}
            loading={loading}
          />
          <KpiCard label="Admins" value={loading ? undefined : counts.admins} loading={loading} />
          <KpiCard label="Users" value={loading ? undefined : counts.editors} loading={loading} />
          <KpiCard
            label="Disabled"
            value={loading ? undefined : counts.disabled}
            loading={loading}
            footnote={counts.disabled > 0 ? 'Cannot sign in' : undefined}
          />
        </KpiStrip>
      )}

      {error && counts.total > 0 && <InlineAlert>{error}</InlineAlert>}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}

      <SectionCard title="Users" padding="flush">
        {!unavailable && (
          <div className="ds-filter-bar team-filter-bar">
            <div className="ds-filter-row">
              <input
                type="search"
                value={search}
                placeholder="Search name or email"
                aria-label="Search name or email"
                onChange={(event) => setSearch(event.target.value)}
              />
              <select
                aria-label="Filter by role"
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value)}
              >
                <option value="">All roles</option>
                <option value="admin">Admin</option>
                <option value="editor">User</option>
              </select>
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>
        )}
        {unavailable ? (
          <EmptyStateV2 variant="unavailable" title="Team administration is unavailable">
            User management is not configured on this installation.
          </EmptyStateV2>
        ) : loading ? (
          <SkeletonTableRows rows={5} columns={5} />
        ) : error && !users.length ? (
          <ErrorState message={error} onRetry={load} />
        ) : (
          <TeamUsersTable
            users={filtered}
            identity={identity}
            busy={busy}
            resetPassword={resetPassword}
            setEditing={setEditing}
            setError={setError}
            setNotice={setNotice}
          />
        )}
      </SectionCard>

      <Drawer open={addOpen} title="Add user" onClose={() => setAddOpen(false)}>
        <TeamAddPanel createUser={createUser} createPassword={createPassword} busy={busy} />
      </Drawer>

      <Drawer
        open={Boolean(editing)}
        title={editing ? `Edit ${editing.label}` : 'Edit user'}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <TeamEditPanel
            user={editing}
            updateUser={updateUser}
            resetPassword={resetPassword}
            busy={busy}
            onCancel={() => setEditing(undefined)}
          />
        )}
      </Drawer>
    </div>
  );
}
