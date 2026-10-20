'use client';
import { HUMAN_QUEUE_LIMITS, type HumanQueueBinding } from '@winsendotai/ovo-contracts';
import { useMemo } from 'react';
import { SelectField, NumberField } from '../../../components/routing/fields';
import { KeyInput } from '../../../components/routing/key-input';
import { IssueList } from '../../../components/routing/issue-list';
import { EmptyStateV2, InlineAlert } from '../../../components/ui/feedback-v2';
import { SectionCard } from '../../../components/ui/section-card';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { freshKey } from '../../../lib/derive/routing-defaults';
import { renameQueueKey } from '../../../lib/derive/routing-draft-edit';
import { queueReadiness, queueUsage } from '../../../lib/derive/routing-queues';
import { useDesigner } from './designer-context';

/** Which workspace queues this point may send callers to, by the key its steps name. */
export function QueuesTab() {
  const { draft, edit, canEdit, status, queues, queueStatus, index } = useDesigner();
  const bindings = draft.humanQueues ?? [];
  const usage = useMemo(() => queueUsage(draft), [draft]);
  const set = (next: HumanQueueBinding[]) =>
    edit((d) => ({ ...d, humanQueues: next.length ? next : undefined }));
  const change = (i: number, patch: Partial<HumanQueueBinding>) =>
    set(bindings.map((b, n) => (n === i ? { ...b, ...patch } : b)));
  const add = () =>
    set([
      ...bindings,
      {
        key: freshKey(
          'desk',
          bindings.map((b) => b.key),
        ),
        queueId: queues[0]?.id ?? '',
        priority: 0,
      },
    ]);
  return (
    <div className="rt-stack rt-pad">
      {!status.humanQueueEnabled && (
        <InlineAlert tone="warn">
          Human queues are not enabled here. Steps that send a caller to a person are skipped, and
          the call moves on to the next fallback step.
        </InlineAlert>
      )}
      <IssueList issues={index.bySection.queues} />
      <SectionCard
        title="Person queues"
        description="Bind a queue to a short key; branches, fallback steps and transfer targets send callers to the key."
        actions={
          canEdit && bindings.length < HUMAN_QUEUE_LIMITS.queuesPerPoint ? (
            <button type="button" className="button" onClick={add}>
              Bind a queue
            </button>
          ) : undefined
        }
      >
        {bindings.length === 0 ? (
          <EmptyStateV2 title="No queues bound">
            Bind an operator desk or a call-centre queue to let this point hand callers to a person.
          </EmptyStateV2>
        ) : (
          <ul className="queue-rows" aria-label="Queue bindings">
            {bindings.map((binding, i) => {
              const record = queues.find((q) => q.id === binding.queueId);
              const ready = queueReadiness(record, queueStatus);
              const where = usage.get(binding.key) ?? [];
              return (
                <li key={i} className="rt-card">
                  <fieldset className="rt-readonly rt-grid" disabled={!canEdit}>
                    <KeyInput
                      id={`queue-${i}-key`}
                      label="Key"
                      value={binding.key}
                      help="What steps call it."
                      onCommit={(to) => {
                        const result = renameQueueKey(draft, binding.key, to);
                        if ('error' in result) return result.error;
                        edit(() => result.draft);
                        return undefined;
                      }}
                    />
                    <SelectField
                      id={`queue-${i}-queue`}
                      label="Queue"
                      value={binding.queueId}
                      placeholder="Choose a queue…"
                      options={queues.map((q) => ({
                        value: q.id,
                        label: `${q.definition.name} (${q.definition.kind === 'managed' ? 'operator desk' : 'webhook'})`,
                      }))}
                      onChange={(queueId) => change(i, { queueId })}
                    />
                    <NumberField
                      id={`queue-${i}-priority`}
                      label="Priority"
                      min={0}
                      max={9}
                      value={binding.priority}
                      help="Higher is served sooner."
                      onChange={(priority) => change(i, { priority })}
                    />
                  </fieldset>
                  <p>
                    <StatusBadgeV2 tone={ready.tone} label={ready.label} size="sm" />{' '}
                    {where.length ? (
                      <span className="muted">Used in {where.join(', ')}</span>
                    ) : (
                      <span className="muted">Not used by any step yet</span>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Unbind ${binding.key}`}
                        onClick={() => set(bindings.filter((_, n) => n !== i))}
                      >
                        Unbind
                      </button>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
