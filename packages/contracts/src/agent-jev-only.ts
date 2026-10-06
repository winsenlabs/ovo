import type { AgentConfig } from './agent.ts';
import type { AgentDecisionQuestion, AgentFlow, DecisionOutcome } from './agent-decision.ts';
import { DEFAULT_DIDNT_CATCH, DEFAULT_GIVE_UP } from './agent-recovery.ts';

/**
 * Every configured way a turn of this agent can reach the LLM, as config paths. Empty means the
 * agent is Jev-only (AGT-4): its decision policy, rules and recovery lines answer every turn, so no
 * LLM needs to be bound and none is ever asked. Conservative: an outcome without a `say` line is
 * counted even when another question's line would usually speak first.
 *
 * At run time an agent with no LLM that still reaches one of these paths speaks its didn't-catch
 * line instead; the release check (`mode_requires_llm`) is what keeps that from being normal.
 */
export function agentLlmPaths(config: AgentConfig): string[] {
  if (config.mode === 'context') return ['mode'];
  if (config.mode !== 'agent') return [];
  // With no policy every caller turn is answered by the LLM.
  if (!config.decision?.enabled) return ['decision'];
  const flow = config.decision.flow;
  // A flow handles an unavailable decision through its own fallback, listed when it is `llm`.
  if (flow) return [...flowLlmPaths(flow), ...commonPaths(config)];
  const paths: string[] = [];
  config.decision.questions.forEach((question, index) => {
    const at = `decision.questions.${index}`;
    if (question.fallback === 'llm') paths.push(`${at}.fallback`);
    for (const [field, outcome] of outcomes(question))
      if (outcome.say === undefined) paths.push(`${at}.${field}.outcome.say`);
  });
  // An unavailable verdict falls through to the LLM unless something else is configured to speak
  // or the agent transfers instead (AGT-15).
  if (
    !config.decisionUnavailable &&
    !config.recovery &&
    !config.handoff?.transfer?.onDecisionUnavailable
  )
    paths.push('decisionUnavailable');
  return [...paths, ...commonPaths(config)];
}

function commonPaths(config: AgentConfig): string[] {
  const paths: string[] = [];
  if (config.recovery?.exhausted.action === 'llm') paths.push('recovery.exhausted.action');
  // Only the LLM selects tools.
  if (config.allowedTools.length) paths.push('allowedTools');
  return paths;
}

/** A flow reaches the LLM through an `llm` fallback, and wherever a state has no lines to say. */
function flowLlmPaths(flow: AgentFlow): string[] {
  const paths = flow.fallback === 'llm' ? ['decision.flow.fallback'] : [];
  flow.nodes.forEach((node, index) => {
    if (!node.say.length) paths.push(`decision.flow.nodes.${index}.say`);
  });
  return paths;
}

function outcomes(question: AgentDecisionQuestion): [string, DecisionOutcome][] {
  if (question.type === 'choice')
    return question.options.map((option, index) => [`options.${index}`, option.outcome]);
  if (question.type === 'noul')
    return [
      ['yes', question.yes.outcome],
      ['no', question.no.outcome],
    ];
  return question.bands.map((band, index) => [`bands.${index}`, band.outcome]);
}

/**
 * Every line the blocks above can speak, with its config path: for release-time template checks
 * and for the clip-cache inventory. A line that is configured but can never be spoken (the give-up
 * line of an `llm` exhaustion) is left out, so nothing is rendered for it.
 */
export function agentRecoveryLines(config: AgentConfig): { field: string; text: string }[] {
  if (config.mode !== 'agent') return [];
  const lines: { field: string; text: string }[] = [];
  const add = (field: string, text: string | undefined) => {
    if (text !== undefined) lines.push({ field, text });
  };
  config.idle?.prompts.forEach((prompt, index) => add(`idle.prompts.${index}`, prompt));
  add('idle.finalLine', config.idle?.finalLine);
  const recovery = config.recovery;
  if (recovery) {
    add('recovery.didntCatch', recovery.didntCatch);
    for (const [key, line] of Object.entries(recovery.reprompts))
      add(`recovery.reprompts.${key}`, line);
    add('recovery.repeat.prefix', recovery.repeat?.prefix);
    if (recovery.exhausted.action === 'end')
      add('recovery.exhausted.line', recovery.exhausted.line);
  }
  add('decisionUnavailable.line', config.decisionUnavailable?.line);
  // Without a recovery block, a miss that no LLM can answer speaks the built-in lines.
  if (!recovery && (config.decisionUnavailable || !agentLlmPaths(config).length)) {
    add('recovery.didntCatch', DEFAULT_DIDNT_CATCH);
    add('recovery.exhausted.line', DEFAULT_GIVE_UP);
  }
  return lines;
}
