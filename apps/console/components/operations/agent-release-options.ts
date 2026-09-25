import { apiRequest, items, type Release } from '../../lib/api';

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

export async function loadAgentReleaseOptions(): Promise<ReleaseOption[]> {
  const { data } = await apiRequest<unknown>('/agents');
  const agents = agentChoiceRows(data);
  const histories = await Promise.all(
    agents.map(async (agent) => {
      const response = await apiRequest<unknown>(
        `/agents/${encodeURIComponent(agent.id)}/releases`,
      );
      return items<Release>(response.data).map((release) => ({
        ...release,
        agentName: agent.name,
      }));
    }),
  );
  return histories.flat();
}
