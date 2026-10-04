import { validateKnowledgeExchange, type KnowledgeResult } from '@winsendotai/ovo-contracts';
import {
  anySignal,
  type KnowledgeKitContext,
  type KnowledgeKitSource,
} from './knowledge-support.ts';

/** One search against a freshly built port, validated before any check looks at it. */
export async function searchOnce(
  context: KnowledgeKitContext,
  sources: readonly KnowledgeKitSource[],
  text: string,
  over: { topK?: number; sourceIds?: string[] } = {},
): Promise<KnowledgeResult> {
  const port = await context.factory({ sources });
  const query = { text, topK: over.topK ?? 5, sourceIds: over.sourceIds ?? [] };
  const result = await port.search(query, { signal: anySignal() });
  return validateKnowledgeExchange(query, result).result;
}
