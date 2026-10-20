'use client';
import { useEffect, useState } from 'react';
import { AgentRefEditor } from '../../../components/routing/agent-ref';
import { NumberField, SwitchField, TagsField } from '../../../components/routing/fields';
import { HoursEditor } from '../../../components/routing/hours-editor';
import { Drawer } from '../../../components/ui/drawer';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import type { PoolMember } from '../../../lib/derive/routing-pools';
import { isRoutingKey } from '../../../lib/derive/routing-edit';
import type { useAgents } from '../../../components/routing/agent-select';

const LANGUAGE = /^[a-z]{2,3}$/;

/** One pool member: the agent and release, who it can serve, how it is ranked and when it is open. */
export function MemberDrawer({
  member,
  isNew,
  takenIds,
  agents,
  onSave,
  onClose,
}: {
  member: PoolMember | undefined;
  isNew: boolean;
  takenIds: readonly string[];
  agents: ReturnType<typeof useAgents>;
  onSave: (member: PoolMember) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<PoolMember>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    setValue(member && structuredClone(member));
    setProblem(undefined);
  }, [member]);
  if (!value)
    return (
      <Drawer open={false} title="Pool member" onClose={onClose}>
        {null}
      </Drawer>
    );
  const set = (patch: Partial<PoolMember>) => setValue({ ...value, ...patch });
  const badLanguages = value.languages.filter((l) => !LANGUAGE.test(l));
  const save = () => {
    if (!isRoutingKey(value.id))
      return setProblem(
        'The member id is lowercase letters, digits, - or _, starting with a letter.',
      );
    if (takenIds.includes(value.id))
      return setProblem(`A member called ${value.id} already exists.`);
    if (!value.agent.agentId) return setProblem('Choose an agent.');
    if (!value.languages.length || badLanguages.length)
      return setProblem('Give at least one language, like en or hi.');
    onSave(value);
  };
  return (
    <Drawer open title={isNew ? 'New pool member' : `Member ${value.id}`} onClose={onClose}>
      <div className="queue-form">
        {problem && <InlineAlert tone="danger">{problem}</InlineAlert>}
        <div className="field">
          <label htmlFor="member-id">Member id</label>
          <input
            id="member-id"
            className="mono"
            value={value.id}
            readOnly={!isNew}
            onChange={(e) => set({ id: e.target.value })}
          />
          <small>
            {isNew
              ? 'Lowercase letters, digits, - or _. It cannot be renamed later.'
              : 'Capacity is counted per member id, so it cannot be renamed.'}
          </small>
        </div>
        <AgentRefEditor
          id="member"
          label="Agent"
          agents={agents}
          value={value.agent}
          onChange={(agent) => set({ agent })}
        />
        <TagsField
          id="member-languages"
          label="Languages it speaks"
          values={value.languages}
          placeholder="hi"
          error={
            badLanguages.length ? `Not a language code: ${badLanguages.join(', ')}` : undefined
          }
          onChange={(languages) => set({ languages })}
        />
        <TagsField
          id="member-products"
          label="Products it handles"
          values={value.products}
          help="Empty: handles any product."
          onChange={(products) => set({ products })}
        />
        <TagsField
          id="member-skills"
          label="Skills"
          values={value.skills}
          onChange={(skills) => set({ skills })}
        />
        <NumberField
          id="member-priority"
          label="Priority"
          min={0}
          max={100}
          value={value.priority}
          help="Higher is tried first. Equal priorities share calls evenly."
          onChange={(priority) => set({ priority })}
        />
        <SwitchField
          label="No limit on concurrent calls"
          checked={value.capacity === undefined}
          onChange={(on) => set({ capacity: on ? undefined : 10 })}
        />
        {value.capacity !== undefined && (
          <NumberField
            id="member-capacity"
            label="Concurrent calls"
            min={1}
            max={10000}
            value={value.capacity}
            onChange={(capacity) => set({ capacity })}
          />
        )}
        <HoursEditor
          idPrefix="member-hours"
          value={value.hours}
          onChange={(hours) => set({ hours })}
        />
        <SwitchField
          label="Takes calls"
          checked={value.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        <div className="button-row queue-form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={save}>
            {isNew ? 'Add member' : 'Apply'}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
