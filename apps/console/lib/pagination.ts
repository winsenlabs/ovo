import { apiRequest, items } from './api';

export async function allPages<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response: { data: unknown } = await apiRequest<unknown>(`${path}${query}`);
    const data = response.data;
    result.push(...items<T>(data));
    const next: string | null = (data as { nextCursor?: string | null } | null)?.nextCursor ?? null;
    if (next && seen.has(next)) throw new Error(`Repeated pagination cursor for ${path}`);
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return result;
}

export function loadAgents<T>(): Promise<T[]> {
  return allPages<T>('/agents');
}
