import {
  FLOW_RESUME_END,
  FLOW_RESUME_TOOL_ID,
  type InferenceStreamEvent,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import type { FlowSession } from './flow-session.ts';

/**
 * AGT-7: the LLM fallback rejoins the flow. When the flow could not place a reply, the LLM answers
 * it and, through the built-in `resume_flow` tool, names the listen set the conversation continues
 * from, so the next turn goes back to the cheap decision path instead of staying with the LLM.
 *
 * The tool is the structured `{reply, resume_at, action}` result. Its `resume_at` is an enum of the
 * resume points the flow offers right now, and it is checked again on the way back: anything else
 * leaves the call where it was. The model is told to say its answer as plain text first and call
 * the tool after it with only `resume_at` and `action`, so the answer streams to TTS like any other
 * reply; `reply` serves a model that puts its answer in the tool anyway.
 */

export interface FlowResume {
  reply: string;
  resumeAt: string;
  action: 'none' | 'end_call';
}

export function flowResumeTool(flow: FlowSession, endAllowed: boolean): ToolDefinition | undefined {
  const options = flow.resumeOptions(endAllowed);
  if (!options.length) return undefined;
  return {
    id: FLOW_RESUME_TOOL_ID,
    description:
      'Hand the call back to the scripted conversation. First say your answer to the caller as ' +
      'plain text, ending with the question that the `resume_at` point expects, then call this ' +
      'with `resume_at` and `action`. Leave `reply` out unless you said nothing as text.',
    connector: 'native',
    inputSchema: {
      type: 'object',
      required: ['resume_at', 'action'],
      properties: {
        reply: { type: 'string', minLength: 1, maxLength: 1_000 },
        resume_at: { type: 'string', enum: options },
        action: { type: 'string', enum: endAllowed ? ['none', 'end_call'] : ['none'] },
      },
      additionalProperties: false,
    },
    effect: 'read',
    confirmation: false,
    timeoutMs: 1_000,
  };
}

/**
 * The prompt section that tells the LLM where the conversation stands and where it may resume, and
 * how to behave on a scripted call (P10): what the caller has already been told, so it does not
 * refuse to name what the call is about; and to steer an unrelated topic back to the question.
 */
export function flowGuide(flow: FlowSession, endAllowed: boolean): string {
  const { compiled } = flow;
  const current = flow.state.listen ? compiled.listens.get(flow.state.listen) : undefined;
  const points = flow
    .resumeOptions(endAllowed)
    .map((id) =>
      id === FLOW_RESUME_END
        ? `- ${FLOW_RESUME_END}: the call ends after your reply.`
        : `- ${id}: ${forPrompt(compiled.listens.get(id)!.question)}`,
    );
  const confirmed = compiled.gatesIdentity && flow.verified;
  const told = confirmed ? flow.disclosed : [];
  return [
    'Conversation flow: the caller said something the scripted conversation could not place.',
    current ? `The agent was waiting for: ${forPrompt(current.question)}` : '',
    confirmed
      ? 'The caller has confirmed who they are and has been told why you are calling. Answer ' +
        'their questions about it (what the account or product is, the amounts, the dates) from ' +
        'the facts you have, and do not ask who they are again.'
      : '',
    told.length
      ? `They have already heard these lines in full, which you may repeat or explain:\n${told
          .map((line) => `- ${line}`)
          .join('\n')}`
      : '',
    'Keep to the purpose of this call. If the caller talks about something unrelated, say in one ' +
      'short, polite sentence that you can only help with this call, then ask again what the ' +
      'agent was waiting for. Do not offer help with unrelated things.',
    `Say a brief answer as plain text, then call \`${FLOW_RESUME_TOOL_ID}\` with the point the ` +
      'conversation continues from:',
    ...points,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The tool input, or undefined when it is not the shape the tool declared. A late call, after the
 * reply was already streamed as text, may leave `reply` empty.
 */
export function readFlowResume(input: unknown, late = false): FlowResume | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { reply = '', resume_at: resumeAt, action } = input as Record<string, unknown>;
  if (typeof reply !== 'string' || (!late && !reply.trim())) return undefined;
  if (typeof resumeAt !== 'string') return undefined;
  if (action !== undefined && action !== 'none' && action !== 'end_call') return undefined;
  return { reply: reply.trim(), resumeAt, action: action ?? 'none' };
}

/**
 * Apply a resume the LLM asked for. `end_call` ends like `resume_at: end`, and only when the agent
 * lets the LLM end calls (`ending.llmTool`). Returns true when the call ends after this reply.
 */
export function applyFlowResume(
  flow: FlowSession,
  resume: Pick<FlowResume, 'resumeAt' | 'action'>,
  endAllowed: boolean,
): boolean {
  const target = resume.action === 'end_call' && endAllowed ? FLOW_RESUME_END : resume.resumeAt;
  return flow.rejoin(target, endAllowed);
}

/**
 * Some models stream the reply as text and then call the tool for the resume point. The text is
 * already spoken, so the late call is applied for its `resume_at` alone and not passed on: to the
 * stream reader, a tool after text is a protocol error.
 */
export async function* interceptLateResume(
  events: AsyncIterable<InferenceStreamEvent>,
  onLateResume: (input: unknown) => void,
): AsyncIterable<InferenceStreamEvent> {
  let text = false;
  for await (const event of events) {
    if (event.kind === 'text-delta' && event.delta) text = true;
    if (text && event.kind === 'tool' && event.toolId === FLOW_RESUME_TOOL_ID) {
      onLateResume(event.input);
      continue;
    }
    yield event;
  }
}

/** Listen questions are written for the decision model; the LLM reads "the reply" instead. */
function forPrompt(question: string): string {
  return question.replace(/`caller_reply`/g, 'the reply');
}
