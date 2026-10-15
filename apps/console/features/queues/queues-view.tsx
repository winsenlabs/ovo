'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, useConfirmDialog } from '../../components/ui/dialog';
import { DataTableV2 } from '../../components/ui/data-table-v2';
import { EmptyStateV2, ErrorState, InlineAlert } from '../../components/ui/feedback-v2';
import { KpiCard, KpiStrip } from '../../components/ui/kpi';
import { PageHeader } from '../../components/ui/layout';
import { SectionCard } from '../../components/ui/section-card';
import { Tabs, tabsFrom } from '../../components/ui/tabs';
import { ApiError, type SessionIdentity } from '../../lib/api';
import { queuesApi } from '../../lib/data/queues-api';
import { queueKpis } from '../../lib/derive/queues';
import type { HumanQueueStatus } from '../../lib/types/desk';
import type { QueueDefinition, QueueRecord } from '../../lib/types/queues';
import { OperatorsTab } from './operators-tab';
import { queueColumns } from './queue-columns';
import { QueueDrawer } from './queue-drawer';
import { TestWebhookResult, type TestState } from './test-webhook';

const TABS = tabsFrom({ queues: 'Queues', operators: 'Operators' });
type Load =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: QueueRecord[]; room: HumanQueueStatus };

/** `/operations/queues`: webhook and operator desk queues, and (admins) who may staff them. */
export function QueuesView({ role }: { role: SessionIdentity['role'] }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [tab, setTab] = useState('queues');
  const [editing, setEditing] = useState<{ record?: QueueRecord; kind: QueueDefinition['kind'] }>();
  const [testing, setTesting] = useState<{ record: QueueRecord; state: TestState }>();
  const [notice, setNotice] = useState<string>();
  const { confirm, dialog } = useConfirmDialog();
  const canEdit = role !== 'viewer';
  const canTest = role === 'admin';

  const reload = useCallback(async () => {
    try {
      const [room, rows] = await Promise.all([queuesApi.status(), queuesApi.list()]);
      setLoad(room.enabled ? { status: 'ready', rows, room } : { status: 'disabled' });
    } catch (failure) {
      setLoad(
        failure instanceof ApiError && failure.code === 'human_queue_disabled'
          ? { status: 'disabled' }
          : { status: 'error', message: failure instanceof Error ? failure.message : 'Queues could not be loaded.' },
      );
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = load.status === 'ready' ? load.rows : [];
  const room = load.status === 'ready' ? load.room : undefined;
  const kpis = queueKpis(rows);

  const runTest = async (record: QueueRecord) => {
    setTesting({ record, state: { status: 'running' } });
    try {
      const result = await queuesApi.testWebhook(record.id);
      setTesting({ record, state: { status: 'done', result } });
    } catch (failure) {
      setTesting({
        record,
        state: { status: 'error', message: failure instanceof Error ? failure.message : 'The test failed.' },
      });
    }
  };
  const remove = async (record: QueueRecord) => {
    if (!(await confirm('Delete queue', `Delete “${record.definition.name}”? Calls already in it are not affected.`)))
      return;
    try {
      await queuesApi.remove(record.id, record.version);
      setNotice(undefined);
      await reload();
    } catch (failure) {
      const usedBy = failure instanceof ApiError ? failure.details?.inUseBy : undefined;
      setNotice(
        Array.isArray(usedBy)
          ? `“${record.definition.name}” is still bound by routing points: ${usedBy.join(', ')}. Unbind it there first.`
          : failure instanceof Error
            ? failure.message
            : 'The queue could not be deleted.',
      );
    }
  };
  const columns = useMemo(
    () =>
      queueColumns({
        status: room,
        canEdit,
        canTest,
        onEdit: (record) => setEditing({ record, kind: record.definition.kind }),
        onTest: (record) => void runTest(record),
        onDelete: (record) => void remove(record),
      }),
    // `runTest` and `remove` only close over stable state setters and `reload`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, canEdit, canTest],
  );

  const header = (
    <PageHeader
      eyebrow="Inbound"
      title="Human queues"
      description="Where callers go when they need a person: a third party's call-centre system, or operators answering in this console."
      actions={
        canEdit && load.status === 'ready' ? (
          <span className="button-row">
            <button type="button" className="button primary" onClick={() => setEditing({ kind: 'managed' })}>
              New operator desk queue
            </button>
            <button type="button" className="button" onClick={() => setEditing({ kind: 'external' })}>
              New webhook queue
            </button>
          </span>
        ) : undefined
      }
    />
  );
  if (load.status === 'loading')
    return (
      <div className="ds-stack">
        {header}
        <KpiStrip>
          {['Queues', 'Waiting now', 'Operators online', 'Webhooks'].map((label) => (
            <KpiCard key={label} label={label} loading />
          ))}
        </KpiStrip>
      </div>
    );
  if (load.status === 'disabled')
    return (
      <div className="ds-stack">
        {header}
        <EmptyStateV2 variant="unavailable" title="Human queues are not enabled here">
          Switch them on for this installation to hand callers to a person.
        </EmptyStateV2>
      </div>
    );
  if (load.status === 'error')
    return (
      <div className="ds-stack">
        {header}
        <ErrorState message={load.message} onRetry={() => void reload()} />
      </div>
    );
  return (
    <div className="ds-stack">
      {header}
      <KpiStrip>
        <KpiCard label="Queues" value={kpis.queues} />
        <KpiCard label="Waiting now" value={kpis.waiting} />
        <KpiCard label="Operators online" value={kpis.online} />
        <KpiCard
          label="Webhooks"
          value={load.room.webhookEnabled ? 'On' : 'Off'}
          footnote={load.room.webhookEnabled ? undefined : 'Outbound webhooks are switched off here'}
        />
      </KpiStrip>
      {!load.room.managedAvailable && (
        <InlineAlert tone="warn">
          Operators cannot answer in the browser: no room server is configured, so operator desk
          queues refuse callers until one is.
        </InlineAlert>
      )}
      {notice && <InlineAlert tone="danger">{notice}</InlineAlert>}
      <SectionCard padding="flush" tabs={role === 'admin' ? <Tabs items={TABS} current={tab} onSelect={setTab} panelId="queues-panel" /> : undefined}>
        <div id="queues-panel" role={role === 'admin' ? 'tabpanel' : undefined}>
          {tab === 'operators' && role === 'admin' ? (
            <OperatorsTab />
          ) : (
            <DataTableV2
              label="Human queues"
              rows={rows}
              columns={columns}
              rowKey={(row) => row.id}
              empty={
                <EmptyStateV2
                  title="No queues yet"
                  action={
                    canEdit ? (
                      <button type="button" className="button primary" onClick={() => setEditing({ kind: 'managed' })}>
                        New operator desk queue
                      </button>
                    ) : undefined
                  }
                >
                  A queue is where a caller waits for a person, and who answers them.
                </EmptyStateV2>
              }
            />
          )}
        </div>
      </SectionCard>
      <QueueDrawer
        open={editing !== undefined}
        record={editing?.record}
        kind={editing?.kind ?? 'managed'}
        canTest={canTest}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          void reload();
        }}
      />
      <Dialog open={testing !== undefined} onClose={() => setTesting(undefined)} title={`Test webhook: ${testing?.record.definition.name ?? ''}`}>
        {testing && <TestWebhookResult test={testing.state} />}
        <button type="button" className="button" onClick={() => setTesting(undefined)}>
          Close
        </button>
      </Dialog>
      {dialog}
    </div>
  );
}
