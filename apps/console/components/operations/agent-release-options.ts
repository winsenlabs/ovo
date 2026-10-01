import { items, type Release } from '../../lib/api';
import { allPages, loadAgents } from '../../lib/pagination';

export interface ReleaseOption extends Release {
  agentName: string;
}

export function agentChoiceRows(data: unknown): Array<{ id: string; name: string }> {
  return items<Record<string, unknown>>(data).map((row) => ({
    id: String(row.id ?? row.agentId),
    name: String(
      (row.config as { name?: unknown } | undefined)?.name ?? row.name ?? row.id ?? row.agentId,
    ),
  }));
}

export async function loadAgentChoices(): Promise<Array<{ id: string; name: string }>> {
  return agentChoiceRows(await loadAgents<unknown>());
}

export async function loadAgentReleaseOptions(): Promise<ReleaseOption[]> {
  const agents = await loadAgentChoices();
  const histories = await Promise.allSettled(
    agents.map(async (agent) => {
      const releases = await allPages<Release>(`/agents/${encodeURIComponent(agent.id)}/releases`);
      return releases.map((release) => ({
        ...release,
        agentName: agent.name,
      }));
    }),
  );
  const successful = histories.filter((result) => result.status === 'fulfilled');
  if (agents.length && !successful.length) throw (histories[0] as PromiseRejectedResult).reason;
  return successful.flatMap((result) => result.value);
}
