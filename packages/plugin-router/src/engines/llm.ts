import { ToolDefinition, type Inference, type InferenceReply } from '@winsendotai/ovo-contracts';
import { ROUTE_TOOL_ID, type RoutingEngine } from '@winsendotai/ovo-contracts';
import {
  branchKeys,
  EngineTimeout,
  turnText,
  withDeadline,
  type EngineInput,
  type EngineResult,
  type EngineRunner,
} from './types.ts';

type LlmEngine = Extract<RoutingEngine, { kind: 'llm' }>;

const CLARIFY_MAX = 200;
const HISTORY_LINES = 12;

/**
 * The single reserved tool the classifier is offered (§7.6): the branch (or null when it cannot
 * tell), its confidence, and, when the engine asks for them, the caller's language and a clarifying
 * question. The enums are the node's branch keys and the call's allowed languages, so the model can
 * only pick from what is configured; the reply is checked against them again in code.
 */
export function routeTool(engine: LlmEngine, input: EngineInput): ToolDefinition {
  const properties: Record<string, unknown> = {
    branch: { enum: [...branchKeys(input.node), null] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  };
  if (engine.detectLanguage) properties.language = { enum: [...input.languages] };
  if (engine.generatedClarify) properties.clarify = { type: 'string', maxLength: CLARIFY_MAX };
  return ToolDefinition.parse({
    id: ROUTE_TOOL_ID,
    description: 'Record where this call should go. Always call this tool, exactly once.',
    connector: 'native',
    effect: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['branch', 'confidence'],
      properties,
    },
  });
}

/** The classifier's instructions: what it routes, the branches it picks from, how to answer. */
export function routeContext(engine: LlmEngine, input: EngineInput): string {
  const branches = input.node.branches.map((branch) => `- ${branch.key}: ${branch.description}`);
  return [
    'You are the call router of a phone line. You never talk to the caller.',
    engine.instructions,
    'Branches:',
    ...branches,
    `Allowed caller languages: ${input.languages.join(', ')}.`,
    `Always call the ${ROUTE_TOOL_ID} tool. Use branch null when the caller's words do not tell ` +
      'you which branch fits. Confidence is how sure you are, from 0 to 1.',
    ...(engine.generatedClarify
      ? ['When unsure, put one short question to the caller in clarify, in their language.']
      : []),
  ].join('\n');
}

const fail = (reason: string, modelId?: string): EngineResult => ({
  outcome: 'error',
  reason,
  ...(modelId ? { modelId } : {}),
});

/** Reads the tool input against the enums it was offered; an out-of-enum value is an error. */
function readTool(
  engine: LlmEngine,
  input: EngineInput,
  reply: Extract<InferenceReply, { kind: 'tool' }>,
  modelId?: string,
): EngineResult {
  if (reply.toolId !== ROUTE_TOOL_ID) return fail('unknown_tool', modelId);
  const args = reply.input as Record<string, unknown> | null;
  if (typeof args !== 'object' || args === null) return fail('invalid_tool_input', modelId);
  const { branch, confidence, language, clarify } = args;
  if (branch !== null && !(typeof branch === 'string' && branchKeys(input.node).includes(branch)))
    return fail('invalid_tool_input', modelId);
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))
    return fail('invalid_tool_input', modelId);
  const detected = engine.detectLanguage && language !== undefined && language !== null;
  if (detected && !(typeof language === 'string' && input.languages.includes(language)))
    return fail('invalid_tool_input', modelId);
  const question =
    engine.generatedClarify && typeof clarify === 'string' && clarify.trim()
      ? clarify.trim().slice(0, CLARIFY_MAX)
      : undefined;
  const result: EngineResult = {
    outcome: branch !== null && confidence >= engine.threshold ? 'matched' : 'low_confidence',
    confidence,
    ...(branch !== null ? { branch } : {}),
    ...(detected ? { language: language as string } : {}),
    ...(modelId ? { modelId } : {}),
  };
  // A generated question is only for a re-ask: a confident verdict never speaks it.
  if (result.outcome === 'low_confidence' && question) result.clarify = question;
  return result;
}

/**
 * The LLM classifier engine (§7.6) over the router release's LLM. A text reply instead of the tool
 * is `no_match` (`llm_text_reply`); a value outside the offered enums is an `error`; a null branch
 * or a confidence under the threshold is `low_confidence`. The model's confidence is its own and
 * uncalibrated. No `Cap.inference` reports `disabled`.
 */
export function createLlmRunner(inference: Inference | undefined): EngineRunner<'llm'> {
  return async (engine: LlmEngine, input: EngineInput): Promise<EngineResult> => {
    if (!inference) return { outcome: 'disabled', reason: 'llm_unavailable' };
    const text = turnText(input.turn);
    if (!text) return { outcome: 'no_match', reason: 'empty_turn' };
    const modelId = inference.model;
    let reply: InferenceReply;
    try {
      reply = await withDeadline(engine.timeoutMs, input.signal, (signal) =>
        inference.generate({
          context: routeContext(engine, input),
          history: input.transcript.slice(-HISTORY_LINES).map((line) => ({
            role: line.role === 'caller' ? ('user' as const) : ('assistant' as const),
            content: line.text,
          })),
          input: text,
          uncertainty: '',
          tools: [routeTool(engine, input)],
          results: [],
          signal,
          providerTools: false,
        }),
      );
    } catch (error) {
      if (error instanceof EngineTimeout)
        return { outcome: 'timeout', ...(modelId ? { modelId } : {}) };
      input.signal.throwIfAborted();
      return fail('llm_failed', modelId);
    }
    if (reply.kind === 'text')
      return { outcome: 'no_match', reason: 'llm_text_reply', ...(modelId ? { modelId } : {}) };
    return readTool(engine, input, reply, modelId);
  };
}
