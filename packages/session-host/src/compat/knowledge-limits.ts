import type { KnowledgeCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/**
 * A policy the selected backend cannot honour, caught at release rather than mid-call. The language
 * check matters most: a lexical backend that cannot match across morphology will quietly return
 * nothing for an agent in a language it does not list, and an ungrounded agent looks exactly like a
 * grounded one that found nothing.
 */
export const knowledgeLimits: CompatRule = (input, stage) => {
  const policy = input.config.knowledge;
  if (!policy?.enabled) return [];
  return resolved(input).flatMap(({ slot, choice, definition }) => {
    if (slot !== 'knowledge') return [];
    const capabilities = manifestKeys(definition.manifest).manifest.capabilities as
      KnowledgeCapabilities | undefined;
    if (!capabilities) return [];
    const at = (field: string) => ({
      slot: 'knowledge' as const,
      pluginId: choice.pluginId,
      field,
    });
    const issues = [];
    if (capabilities.maxTopK > 0 && policy.topK > capabilities.maxTopK)
      issues.push(
        issue(
          'knowledge_limit_exceeded',
          stage,
          `${choice.pluginId} returns at most ${capabilities.maxTopK} passages; the policy asks for ${policy.topK}`,
          at('topK'),
        ),
      );
    if (
      capabilities.languages.length &&
      !capabilities.languages.includes('*') &&
      !capabilities.languages.includes(input.config.language)
    )
      issues.push(
        issue(
          'knowledge_limit_exceeded',
          stage,
          `${choice.pluginId} does not support ${input.config.language}`,
          at('language'),
        ),
      );
    // A budget below one passage means the budget trim discards everything the threshold kept.
    if (
      capabilities.maxPassageCharacters > 0 &&
      policy.maxCharacters < capabilities.maxPassageCharacters
    )
      issues.push(
        issue(
          'knowledge_limit_exceeded',
          stage,
          `${choice.pluginId} returns passages up to ${capabilities.maxPassageCharacters} characters, above the policy budget of ${policy.maxCharacters}: a full passage would always be dropped`,
          at('maxCharacters'),
          'warning',
        ),
      );
    return issues;
  });
};
