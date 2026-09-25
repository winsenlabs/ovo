import { apiRequest } from '../../lib/api';
import type { EvaluationCase } from '../../lib/operator-api';
type Page<T> = { items: T[]; nextCursor?: string };
export async function loadCases(datasetId: string, version: number): Promise<EvaluationCase[]> {
  const collected: EvaluationCase[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const { data } = await apiRequest<Page<EvaluationCase>>(
      `/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}/cases?${query}`,
    );
    collected.push(...data.items);
    cursor = data.nextCursor;
  } while (cursor && collected.length < 120);
  return collected.slice(0, 120);
}
