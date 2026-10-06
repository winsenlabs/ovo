import type { z } from 'zod';
import type { AgentDecisionPolicy, AgentDecisionQuestion } from './agent-decision.ts';
import type { AgentDecisionUnavailable, AgentRecovery } from './agent-recovery.ts';
import { ruleDecisionTarget, type AgentRules } from './agent-rules.ts';

/** The agent config fields that name decision targets, as the config check sees them. */
export interface RoutingTargets {
  decision?: AgentDecisionPolicy;
  rules?: AgentRules;
  recovery?: AgentRecovery;
  decisionUnavailable?: AgentDecisionUnavailable;
}

/**
 * Rules, re-asks and the unavailable line all route through the decision policy; without one they
 * would validate and never run. Each rule and re-ask must name something the policy offers.
 */
export function checkRoutingTargets(config: RoutingTargets, ctx: z.RefinementCtx): void {
  const questions = config.decision?.enabled ? config.decision.questions : undefined;
  for (const field of ['rules', 'decisionUnavailable'] as const)
    if (config[field] && !questions)
      ctx.addIssue({
        code: 'custom',
        message: `${field} needs an enabled decision policy`,
        path: [field],
      });
  // A policy with no questions routes by a flow, whose listen sets and intents these name instead.
  if (questions && !questions.length) return;
  for (const key of Object.keys(config.recovery?.reprompts ?? {}))
    if (!questions?.some((question) => question.id === key))
      ctx.addIssue({
        code: 'custom',
        message: `Re-ask ${key} names no decision question`,
        path: ['recovery', 'reprompts', key],
      });
  if (!questions) return;
  config.rules?.global.forEach((rule, index) => {
    const problem = flatRuleTarget(rule.intent, questions);
    if (problem)
      ctx.addIssue({ code: 'custom', message: problem, path: ['rules', 'global', index] });
  });
  if (config.rules && Object.keys(config.rules.listens).length)
    ctx.addIssue({
      code: 'custom',
      message: 'Listen-set rules need a flow; use global rules for a decision policy',
      path: ['rules', 'listens'],
    });
}

/** Why a flat agent's rule target does not name an answer its decision policy offers. */
function flatRuleTarget(
  intent: string,
  questions: readonly AgentDecisionQuestion[],
): string | undefined {
  const target = ruleDecisionTarget(intent);
  if (!target) return `Rule ${intent} must name <question>=<answer> without a flow`;
  const question = questions.find((candidate) => candidate.id === target.question);
  if (!question) return `Rule ${intent} names no decision question`;
  const answers =
    question.type === 'choice'
      ? question.options.map((option) => option.key)
      : question.type === 'noul'
        ? ['yes', 'no']
        : [];
  return answers.includes(target.answer)
    ? undefined
    : `Rule ${intent} names no answer of ${question.id}`;
}
