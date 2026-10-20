'use client';
import { routingApi } from '../../lib/data/routing-api';
import { useRoutingLoad } from '../../lib/data/use-routing-load';
import type { AgentOption } from '../../lib/types/routing';
import { SelectField } from './fields';

/** The workspace's agents, loaded once per mount; shared by every picker that names an agent. */
export function useAgents() {
  const { state } = useRoutingLoad<AgentOption[]>(routingApi.agents);
  return state;
}

export function AgentSelect({
  id,
  label,
  value,
  onChange,
  agents,
  error,
  help,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (agentId: string) => void;
  agents: ReturnType<typeof useAgents>;
  error?: string;
  help?: string;
}) {
  const options =
    agents.status === 'ready' ? agents.data.map((a) => ({ value: a.id, label: a.name })) : [];
  // An agent the list no longer shows stays selectable so the draft is not silently changed.
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
  return (
    <SelectField
      id={id}
      label={label}
      value={value}
      placeholder={
        agents.status === 'loading'
          ? 'Loading agents…'
          : options.length
            ? 'Choose an agent…'
            : 'No agents yet'
      }
      options={options}
      onChange={onChange}
      error={error ?? (agents.status === 'error' ? 'Agents could not be loaded' : undefined)}
      help={help}
    />
  );
}
