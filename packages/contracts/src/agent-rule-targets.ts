import type { z } from 'zod';
import type { AgentDecisionPolicy, AgentDecisionQuestion, AgentFlow } from './agent-decision.ts';
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
  if (questions && !questions.length) {
    if (config.decision?.flow) checkFlowTargets(config, config.decision.flow, ctx);
    return;
  }
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

/** Re-asks and listen-set rules name the flow's listen sets; every rule names one of its intents. */
function checkFlowTargets(config: RoutingTargets, flow: AgentFlow, ctx: z.RefinementCtx): void {
  const listens = new Map(flow.listens.map((listen) => [listen.id, listen]));
  const globals = flow.globalIntents.map((intent) => intent.key);
  const anywhere = new Set([
    ...globals,
    ...flow.listens.flatMap((listen) => listen.intents.map((intent) => intent.key)),
  ]);
  for (const key of Object.keys(config.recovery?.reprompts ?? {}))
    if (!listens.has(key))
      ctx.addIssue({
        code: 'custom',
        message: `Re-ask ${key} names no listen set of the flow`,
        path: ['recovery', 'reprompts', key],
      });
  config.rules?.global.forEach((rule, index) => {
    if (!anywhere.has(rule.intent))
      ctx.addIssue({
        code: 'custom',
        message: `Rule ${rule.intent} names no intent of the flow`,
        path: ['rules', 'global', index],
      });
  });
  for (const [id, rules] of Object.entries(config.rules?.listens ?? {})) {
    const listen = listens.get(id);
    const keys = new Set([...(listen?.intents.map((intent) => intent.key) ?? []), ...globals]);
    if (!listen)
      ctx.addIssue({
        code: 'custom',
        message: `Rules for ${id} name no listen set of the flow`,
        path: ['rules', 'listens', id],
      });
    else
      rules.forEach((rule, index) => {
        if (!keys.has(rule.intent))
          ctx.addIssue({
            code: 'custom',
            message: `Rule ${rule.intent} names no intent of listen set ${id}`,
            path: ['rules', 'listens', id, index],
          });
      });
  }
}
