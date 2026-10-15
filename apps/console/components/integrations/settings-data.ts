import { ApiError, items, normalizeDraft, type AgentDraft } from '../../lib/api';
import { loadAgents } from '../../lib/pagination';

export type Loaded<T> = { status: 'loading' | 'ready' | 'error'; data: T; error?: string };

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * Turns one `Promise.allSettled` branch of a list GET into a `Loaded<T>`, the shape both the
 * Providers (`providers-settings.tsx`) and Tools (`use-mcp-connections.ts`) screens load their
 * collections into. A 403 is a role restriction, not an outage: `allow403` renders it as an empty
 * `ready` list instead of an error banner.
 */
export function settleList<T>(
  result: PromiseSettledResult<{ data: unknown }>,
  fallback: string,
  { allow403 = false }: { allow403?: boolean } = {},
): Loaded<T[]> {
  if (result.status === 'fulfilled') return { status: 'ready', data: items<T>(result.value.data) };
  const denied = allow403 && result.reason instanceof ApiError && result.reason.status === 403;
  return {
    status: denied ? 'ready' : 'error',
    data: [],
    error: denied ? undefined : safeMessage(result.reason, fallback),
  };
}

/** Every page in this screen group loads agents the same way: full pagination, drafts only. */
export async function loadNormalizedAgents(): Promise<AgentDraft[]> {
  const agents = await loadAgents<Record<string, unknown>>();
  return agents.filter((value) => value.config).map((value) => normalizeDraft(value));
}
