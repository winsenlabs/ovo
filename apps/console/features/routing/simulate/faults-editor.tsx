'use client';
import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { optionsFrom, SelectField } from '../../../components/routing/fields';
import type { SimForm } from '../../../lib/derive/routing-simulate';
import type { QueueFault } from '../../../lib/types/routing-simulate';
import type { PoolRecord } from '../../../lib/types/routing';

const FLAGS = optionsFrom({ server: 'As the server is set', on: 'Switch on', off: 'Switch off' });
const QUEUE_FAULTS = [
  { value: '', label: 'Works' },
  { value: 'queue_closed', label: 'Closed' },
  { value: 'queue_unavailable', label: 'Unavailable' },
  { value: 'no_operators', label: 'No operators online' },
  { value: 'queue_full', label: 'Full' },
];

/** What-ifs: switch features on or off, make members full, make a queue refuse, load the pools. */
export function FaultsEditor({
  form,
  onChange,
  draft,
  pools,
}: {
  form: SimForm;
  onChange: (form: SimForm) => void;
  draft: RoutingPointDraft;
  pools: readonly PoolRecord[];
}) {
  const queues = draft.humanQueues ?? [];
  const isFull = (poolId: string, memberId: string) =>
    form.fullMembers.some((f) => f.poolId === poolId && f.memberId === memberId);
  const toggleFull = (poolId: string, memberId: string) =>
    onChange({
      ...form,
      fullMembers: isFull(poolId, memberId)
        ? form.fullMembers.filter((f) => !(f.poolId === poolId && f.memberId === memberId))
        : [...form.fullMembers, { poolId, memberId }],
    });
  return (
    <div className="rt-stack">
      <div className="rt-grid">
        <SelectField
          id="assume-transfers"
          label="Transfers"
          value={form.transfers}
          options={FLAGS}
          onChange={(transfers) =>
            onChange({ ...form, transfers: transfers as SimForm['transfers'] })
          }
        />
        <SelectField
          id="assume-queues"
          label="Person queues"
          value={form.humanQueues}
          options={FLAGS}
          onChange={(humanQueues) =>
            onChange({ ...form, humanQueues: humanQueues as SimForm['humanQueues'] })
          }
        />
        <SelectField
          id="sim-load"
          label="How busy the agents are"
          value={form.load}
          options={[
            { value: 'empty', label: 'Everyone is free' },
            { value: 'live', label: 'The live number of calls' },
          ]}
          onChange={(load) => onChange({ ...form, load: load as 'empty' | 'live' })}
        />
      </div>
      {queues.length > 0 && (
        <fieldset className="queue-section">
          <legend>Make a person queue refuse</legend>
          {queues.map((q) => (
            <SelectField
              key={q.key}
              id={`fault-queue-${q.key}`}
              label={q.key}
              value={form.queues[q.key] ?? ''}
              options={QUEUE_FAULTS}
              onChange={(fault) => {
                const next = { ...form.queues };
                if (fault) next[q.key] = fault as QueueFault;
                else delete next[q.key];
                onChange({ ...form, queues: next });
              }}
            />
          ))}
        </fieldset>
      )}
      {pools.length > 0 && (
        <fieldset className="queue-section">
          <legend>Make members full</legend>
          {pools.map((pool) => (
            <div key={pool.id}>
              <strong>{pool.definition.name}</strong>
              <ul className="rt-checks">
                {pool.definition.members.map((m) => (
                  <li key={m.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={isFull(pool.id, m.id)}
                        onChange={() => toggleFull(pool.id, m.id)}
                      />{' '}
                      {m.id} is at capacity
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
}
