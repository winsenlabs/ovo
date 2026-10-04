import type { AgentKnowledgePolicy } from './agent-knowledge.ts';
import type { KnowledgePassage, KnowledgeQuery, KnowledgeResult } from './knowledge.ts';

/** The query one turn asks, from the policy and the caller's words. */
export function knowledgeQuery(policy: AgentKnowledgePolicy, text: string): KnowledgeQuery {
  return {
    text,
    topK: policy.topK,
    sourceIds: [...policy.sourceIds],
  };
}

export interface GroundedPassages {
  used: readonly KnowledgePassage[];
  /** Dropped because they scored below the authored threshold. */
  belowThreshold: number;
  /** Dropped because the character budget was already spent on better-ranked passages. */
  overBudget: number;
  revision: string;
}

/**
 * Apply the authored threshold and character budget. Pure, and it never truncates a passage: half a
 * sentence of policy text read back to a caller is worse than one passage fewer.
 */
export function groundPassages(
  policy: AgentKnowledgePolicy,
  result: KnowledgeResult,
): GroundedPassages {
  const used: KnowledgePassage[] = [];
  let belowThreshold = 0;
  let overBudget = 0;
  let spent = 0;
  for (const passage of result.passages) {
    if (passage.score < policy.minScore) {
      belowThreshold += 1;
      continue;
    }
    const length = [...passage.text].length;
    if (spent + length > policy.maxCharacters) {
      overBudget += 1;
      continue;
    }
    spent += length;
    used.push(passage);
  }
  return { used, belowThreshold, overBudget, revision: result.revision };
}

/**
 * Retrieved passages as text for a prompt or a decision's state. Each passage keeps its citation, so
 * an answer can be traced to what was read and an operator can tell a quotation from an invention.
 */
export function renderPassages(passages: readonly KnowledgePassage[]): string {
  return passages
    .map((passage, index) =>
      [`[${index + 1}] ${passage.citation ?? passage.sourceId}`, passage.text].join('\n'),
    )
    .join('\n\n');
}
