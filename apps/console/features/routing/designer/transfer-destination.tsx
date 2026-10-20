'use client';
import type { TransferDestination, TransferSource } from '@winsendotai/ovo-contracts';
import { AgentRefEditor } from '../../../components/routing/agent-ref';
import { optionsFrom, SelectField, SwitchField, TagsField, TextField } from '../../../components/routing/fields';
import { blankTarget } from '../../../lib/derive/routing-defaults';
import { useDesigner } from './designer-context';
import { PoolFields } from './target-editor';

const KINDS = optionsFrom({ pool: 'An agent pool', 'same-pool': "The transferring agent's pool", agent: 'One agent', node: 'Back to the router, at a question', human: 'A person' });

/** Where a transfer goes. */
export function DestinationEditor({ value, onChange, id }: { value: TransferDestination; onChange: (value: TransferDestination) => void; id: string }) {
  const { draft } = useDesigner();
  const queueKeys = (draft.humanQueues ?? []).map((b) => b.key);
  const change = (kind: string): TransferDestination => {
    if (kind === 'same-pool') return { kind, language: 'caller', skills: [] };
    if (kind === 'node') return { kind, node: draft.root };
    if (kind === 'pool' || kind === 'agent' || kind === 'human') return blankTarget(kind) as TransferDestination;
    return value;
  };
  return (
    <div className="rt-stack">
      <SelectField id={`${id}-kind`} label="Sends the caller to" value={value.kind} options={KINDS} onChange={(kind) => onChange(change(kind))} />
      {value.kind === 'pool' && <PoolFields id={id} target={value} onChange={(t) => onChange(t as TransferDestination)} />}
      {value.kind === 'same-pool' && (
        <>
          <SelectField id={`${id}-lang`} label="Agent language" value={value.language} options={[{ value: 'caller', label: "Must speak the caller's language" }, { value: 'any', label: 'Any language' }]} onChange={(language) => onChange({ ...value, language: language as 'caller' | 'any' })} />
          <TagsField id={`${id}-skills`} label="Skills needed" values={value.skills} onChange={(skills) => onChange({ ...value, skills })} />
        </>
      )}
      {value.kind === 'agent' && <AgentRefEditor id={id} value={value.agent} onChange={(agent) => onChange({ ...value, agent })} />}
      {value.kind === 'node' && <SelectField id={`${id}-node`} label="Question" value={value.node} options={draft.nodes.map((n) => ({ value: n.id, label: n.id }))} onChange={(node) => onChange({ ...value, node })} />}
      {value.kind === 'human' && (
        <SelectField id={`${id}-queue`} label="Person queue" value={value.queueId} placeholder={queueKeys.length ? 'Choose a queue…' : 'Bind a queue first'} options={queueKeys.map((k) => ({ value: k, label: k }))} onChange={(queueId) => onChange({ ...value, queueId })} />
      )}
    </div>
  );
}

const SOURCE_KINDS = optionsFrom({ pool: 'Anyone from a pool', member: 'One pool member', agent: 'One agent' });

/** Who may use a target: every agent of the point, or a list of pools, members and agents. */
export function SourcesEditor({ value, onChange, id }: { value: TransferSource[] | undefined; onChange: (value: TransferSource[] | undefined) => void; id: string }) {
  const { pools, agents } = useDesigner();
  const poolId = pools[0]?.id ?? '';
  const set = (i: number, source: TransferSource) => onChange((value ?? []).map((s, n) => (n === i ? source : s)));
  return (
    <div className="rt-stack">
      <SwitchField label="Any agent of this point may use it" checked={value === undefined} onChange={(any) => onChange(any ? undefined : [{ kind: 'pool', poolId }])} />
      {value?.map((source, i) => (
        <div key={i} className="rt-card">
          <SelectField id={`${id}-s${i}-kind`} label={`Source ${i + 1}`} value={source.kind} options={SOURCE_KINDS} onChange={(kind) => set(i, kind === 'agent' ? { kind, agentId: '' } : kind === 'member' ? { kind, poolId, memberId: '' } : { kind: 'pool', poolId })} />
          {source.kind !== 'agent' && <SelectField id={`${id}-s${i}-pool`} label="Pool" value={source.poolId} options={pools.map((p) => ({ value: p.id, label: p.definition.name }))} onChange={(next) => set(i, { ...source, poolId: next })} />}
          {source.kind === 'member' && <TextField id={`${id}-s${i}-member`} label="Member id" mono value={source.memberId} onChange={(memberId) => set(i, { ...source, memberId })} />}
          {source.kind === 'agent' && <SelectField id={`${id}-s${i}-agent`} label="Agent" value={source.agentId} placeholder="Choose an agent…" options={(agents.status === 'ready' ? agents.data : []).map((a) => ({ value: a.id, label: a.name }))} onChange={(agentId) => set(i, { ...source, agentId })} />}
          <button type="button" className="text-button" disabled={value.length <= 1} onClick={() => onChange(value.filter((_, n) => n !== i))}>Remove source {i + 1}</button>
        </div>
      ))}
      {value && <button type="button" className="button" disabled={value.length >= 50} onClick={() => onChange([...value, { kind: 'pool', poolId }])}>Add source</button>}
    </div>
  );
}
