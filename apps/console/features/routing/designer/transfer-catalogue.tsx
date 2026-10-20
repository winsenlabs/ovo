'use client';
import {
  TRANSFER_LIMITS,
  type RoutingTransferPolicy,
  type TransferTarget,
} from '@winsendotai/ovo-contracts';
import { useState } from 'react';
import { IssueList } from '../../../components/routing/issue-list';
import { LinesEditor } from '../../../components/routing/lines-editor';
import { NumberField, SelectField, SwitchField } from '../../../components/routing/fields';
import { DataTableV2, type ColumnV2 } from '../../../components/ui/data-table-v2';
import { EmptyStateV2 } from '../../../components/ui/feedback-v2';
import { SectionCard } from '../../../components/ui/section-card';
import { blankTransferTarget, freshKey } from '../../../lib/derive/routing-defaults';
import { useDesigner } from './designer-context';
import { TargetDrawer } from './target-drawer';

const destinationLabel = (t: TransferTarget) => {
  const d = t.destination;
  return d.kind === 'pool'
    ? 'Pool'
    : d.kind === 'same-pool'
      ? 'Same pool'
      : d.kind === 'agent'
        ? 'One agent'
        : d.kind === 'node'
          ? `Router at ${d.node}`
          : 'A person';
};

type Change = (patch: Partial<RoutingTransferPolicy>) => void;

/** The catalogue: where an agent may send a caller, with a drawer per target. */
export function TransferTargets({
  policy,
  onChange: setPolicy,
}: {
  policy: RoutingTransferPolicy;
  onChange: Change;
}) {
  const { draft, canEdit, index } = useDesigner();
  const [editing, setEditing] = useState<{ target?: TransferTarget; index: number }>();
  const keys = policy.targets.map((t) => t.key);
  const saveTarget = (target: TransferTarget) => {
    const next = [...policy.targets];
    if (editing && editing.index >= 0) next[editing.index] = target;
    else next.push(target);
    setPolicy({ targets: next });
    setEditing(undefined);
  };
  const columns: ColumnV2<TransferTarget>[] = [
    { id: 'key', header: 'Key', cell: (t) => <strong className="mono">{t.key}</strong> },
    { id: 'description', header: 'When to use it', priority: 'low', cell: (t) => t.description },
    { id: 'destination', header: 'Goes to', cell: destinationLabel },
    {
      id: 'confirm',
      header: 'Asks first',
      priority: 'low',
      cell: (t) => ((t.confirm ?? policy.confirm) === 'ask' ? 'Yes' : 'No'),
    },
    { id: 'hold', header: 'Own hold', priority: 'low', cell: (t) => (t.hold ? 'Yes' : '—') },
    {
      id: 'from',
      header: 'Who may use it',
      priority: 'low',
      cell: (t) =>
        t.from ? `${t.from.length} source${t.from.length === 1 ? '' : 's'}` : 'Any agent',
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (t) =>
        canEdit ? (
          <span className="button-row">
            <button
              type="button"
              className="button small"
              aria-label={`Edit target ${t.key}`}
              onClick={() => setEditing({ target: t, index: policy.targets.indexOf(t) })}
            >
              Edit
            </button>
            <button
              type="button"
              className="button small danger"
              aria-label={`Delete target ${t.key}`}
              onClick={() => setPolicy({ targets: policy.targets.filter((x) => x !== t) })}
            >
              Delete
            </button>
          </span>
        ) : null,
    },
  ];
  return (
    <>
      <SectionCard
        title="Transfer targets"
        description="Where an agent may send the caller. The agent's model chooses by the description and never sees the destination."
        actions={
          canEdit ? (
            <button
              type="button"
              className="button"
              disabled={policy.targets.length >= TRANSFER_LIMITS.targets}
              onClick={() =>
                setEditing({
                  index: -1,
                  target: blankTransferTarget(freshKey('target', keys), draft.defaultTarget),
                })
              }
            >
              Add target
            </button>
          ) : undefined
        }
      >
        <IssueList issues={index.bySection.transfer} />
        <DataTableV2
          label="Transfer targets"
          rows={policy.targets}
          columns={columns}
          rowKey={(t) => t.key}
          empty={
            <EmptyStateV2 title="No transfer targets">
              Agents of this point cannot transfer a call until you add a target.
            </EmptyStateV2>
          }
        />
      </SectionCard>
      <TargetDrawer
        target={editing?.target}
        isNew={editing !== undefined && editing.index < 0}
        existingKeys={
          editing && editing.index >= 0 ? keys.filter((_, i) => i !== editing.index) : keys
        }
        onSave={saveTarget}
        onClose={() => setEditing(undefined)}
      />
    </>
  );
}

/** Announcements, confirmation, limits and handover for every transfer of the point. */
export function TransferDefaults({
  policy,
  onChange: setPolicy,
}: {
  policy: RoutingTransferPolicy;
  onChange: Change;
}) {
  return (
    <>
      <SectionCard title="Transfer defaults">
        <LinesEditor
          label="Announcement before a transfer"
          value={policy.announcement}
          onChange={(announcement) => setPolicy({ announcement })}
        />
        <LinesEditor
          label="Said when every agent is busy"
          value={policy.queueAnnouncement}
          onChange={(queueAnnouncement) => setPolicy({ queueAnnouncement })}
        />
        <SelectField
          id="transfer-confirm"
          label="Ask the caller first"
          value={policy.confirm}
          options={[
            { value: 'never', label: 'Never ask' },
            { value: 'ask', label: 'Ask "shall I transfer you?"' },
          ]}
          onChange={(confirm) => setPolicy({ confirm: confirm as 'never' | 'ask' })}
        />
      </SectionCard>
      <SectionCard title="Limits">
        <div className="rt-grid">
          <NumberField
            id="limit-transfers"
            label="Most transfers per call"
            min={1}
            max={TRANSFER_LIMITS.maxTransfersPerCall}
            value={policy.limits.maxTransfers}
            onChange={(maxTransfers) => setPolicy({ limits: { ...policy.limits, maxTransfers } })}
          />
          <NumberField
            id="limit-remaining"
            label="Not when less is left than"
            unit="seconds"
            min={10}
            max={600}
            value={policy.limits.minRemainingSeconds}
            onChange={(minRemainingSeconds) =>
              setPolicy({ limits: { ...policy.limits, minRemainingSeconds } })
            }
          />
          <SelectField
            id="limit-return"
            label="Back to an agent already left"
            value={policy.limits.returnToPrevious}
            options={[
              { value: 'refuse', label: 'Refuse' },
              { value: 'allow', label: 'Allow' },
            ]}
            onChange={(returnToPrevious) =>
              setPolicy({
                limits: {
                  ...policy.limits,
                  returnToPrevious: returnToPrevious as 'refuse' | 'allow',
                },
              })
            }
          />
        </div>
      </SectionCard>
      <SectionCard title="What the next agent is told">
        <SwitchField
          label="A summary of the call so far"
          checked={policy.handover.summary}
          onChange={(summary) => setPolicy({ handover: { ...policy.handover, summary } })}
        />
        <SwitchField
          label="The variables captured so far"
          checked={policy.handover.capturedVariables}
          onChange={(capturedVariables) =>
            setPolicy({ handover: { ...policy.handover, capturedVariables } })
          }
        />
        <NumberField
          id="handover-turns"
          label="Recent turns of the conversation"
          min={0}
          max={TRANSFER_LIMITS.transcriptTurns}
          value={policy.handover.transcriptTurns}
          onChange={(transcriptTurns) =>
            setPolicy({ handover: { ...policy.handover, transcriptTurns } })
          }
        />
      </SectionCard>
    </>
  );
}
