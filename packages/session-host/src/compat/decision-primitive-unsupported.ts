import type { DecisionCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/**
 * A question the selected model cannot answer, caught at release rather than mid-call. Covers the
 * three limits a decision manifest declares: which primitives it answers, how many choice criteria
 * one question may carry, and how many questions fit in one request.
 */
export const decisionPrimitiveUnsupported: CompatRule = (input, stage) => {
  const policy = input.config.decision;
  if (!policy?.enabled) return [];
  return resolved(input).flatMap(({ slot, choice, definition }) => {
    if (slot !== 'decision') return [];
    const capabilities = manifestKeys(definition.manifest).manifest.capabilities as
      DecisionCapabilities | undefined;
    if (!capabilities?.primitives) return [];
    const at = (id: string) => ({
      slot: 'decision' as const,
      pluginId: choice.pluginId,
      field: id,
    });
    const issues = policy.questions.flatMap((question) => {
      if (!capabilities.primitives.includes(question.type))
        return [
          issue(
            'decision_primitive_unsupported',
            stage,
            `${choice.pluginId} does not answer ${question.type} questions, which ${question.id} is`,
            at(question.id),
          ),
        ];
      if (
        question.type === 'choice' &&
        capabilities.maxCriteria > 0 &&
        question.options.length > capabilities.maxCriteria
      )
        return [
          issue(
            'decision_primitive_unsupported',
            stage,
            `${question.id} offers ${question.options.length} options; ${choice.pluginId} accepts ${capabilities.maxCriteria}`,
            at(question.id),
          ),
        ];
      return [];
    });
    if (
      capabilities.maxQuestionsPerRequest > 0 &&
      policy.questions.length > capabilities.maxQuestionsPerRequest
    )
      issues.push(
        issue(
          'decision_primitive_unsupported',
          stage,
          `${policy.questions.length} questions are asked together; ${choice.pluginId} accepts ${capabilities.maxQuestionsPerRequest} per request`,
          { slot: 'decision', pluginId: choice.pluginId, field: 'questions' },
        ),
      );
    return issues;
  });
};
