'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataTableV2, type ColumnV2 } from '../../components/ui/data-table-v2';
import { RelativeTime, Switch } from '../../components/ui/display';
import { EmptyStateV2 } from '../../components/ui/feedback-v2';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import { queuesApi } from '../../lib/data/queues-api';
import type { OperatorRow } from '../../lib/types/queues';
import { OperatorDrawer, type UserOption } from './operator-drawer';

/** Operator profiles with live presence (admins only). */
export function OperatorsTab() {
  const [rows, setRows] = useState<OperatorRow[]>();
  const [users, setUsers] = useState<UserOption[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<{ operator?: OperatorRow }>();

  const reload = useCallback(async () => {
    try {
      const [operators, team] = await Promise.all([queuesApi.operators(), queuesApi.users()]);
      setRows(operators);
      setUsers(team.filter((user) => !user.disabled));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Operators could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = useCallback(
    async (row: OperatorRow, enabled: boolean) => {
      const { status: _status, active: _active, ...profile } = row;
      try {
        await queuesApi.saveOperator(row.userId, { ...profile, enabled });
        await reload();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The operator could not be changed.');
      }
    },
    [reload],
  );

  const columns = useMemo<ColumnV2<OperatorRow>[]>(
    () => [
      {
        id: 'name',
        header: 'Operator',
        cell: (row) => (
          <span>
            <strong>{row.displayName || row.label || row.userId}</strong>
            {row.email && <small className="muted"> {row.email}</small>}
          </span>
        ),
      },
      {
        id: 'enabled',
        header: 'Can answer',
        cell: (row) => (
          <Switch
            label={`${row.displayName || row.userId} can answer`}
            checked={row.enabled}
            disabled={row.userDisabled}
            onChange={(enabled) => void toggle(row, enabled)}
          />
        ),
      },
      {
        id: 'teams',
        header: 'Teams',
        priority: 'low',
        cell: (row) => (row.teamIds.length ? row.teamIds.join(', ') : 'All'),
      },
      {
        id: 'languages',
        header: 'Languages',
        priority: 'low',
        cell: (row) => (row.languages.length ? row.languages.join(', ') : '—'),
      },
      { id: 'capacity', header: 'Calls at once', align: 'end', cell: (row) => `${row.active} of ${row.capacity}` },
      {
        id: 'presence',
        header: 'Presence',
        cell: (row) => <StatusBadgeV2 value={row.status.toLowerCase()} label={row.status === 'AVAILABLE' ? 'Available' : row.status === 'AWAY' ? 'Away' : 'Offline'} />,
      },
      { id: 'seen', header: 'Last seen', priority: 'low', cell: (row) => <RelativeTime value={row.lastSeenAt} /> },
      {
        id: 'actions',
        header: 'Actions',
        align: 'end',
        cell: (row) => (
          <button type="button" className="button" aria-label={`Edit ${row.displayName || row.userId}`} onClick={() => setEditing({ operator: row })}>
            Edit
          </button>
        ),
      },
    ],
    [toggle],
  );

  return (
    <>
      <div className="queue-tab-actions">
        <button type="button" className="button primary" onClick={() => setEditing({})}>
          Add operator
        </button>
      </div>
      <DataTableV2
        label="Operators"
        rows={rows ?? []}
        columns={columns}
        rowKey={(row) => row.userId}
        loading={rows === undefined && !error}
        error={error}
        onRetry={() => void reload()}
        empty={
          <EmptyStateV2 title="No operators yet">
            Add team members who may answer calls on the operator desk.
          </EmptyStateV2>
        }
      />
      <OperatorDrawer
        open={editing !== undefined}
        operator={editing?.operator}
        users={users}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          void reload();
        }}
      />
    </>
  );
}
