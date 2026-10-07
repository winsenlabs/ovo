import type { streamText, Tool } from 'ai';
import type { InferenceRequest, InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import type { StepActivity } from './ai-sdk-activity.ts';
import { InferenceProtocolError, compactUsage } from './ai-sdk-support.ts';

/** A tool the provider ran itself inside the step (web search), as the AI SDK reported it. */
export interface ProviderToolResult {
  toolName: string;
  output: unknown;
}

/**
 * One streamed provider step as OVO events: text deltas, then at most one OVO tool call, then
 * `finish` once `report` has metered the step. Provider-run tools (web search) never become a
 * reply; `activity` follows them as they happen.
 */
export async function* readStepStream(input: {
  request: InferenceRequest;
  parts: ReturnType<typeof streamText>['fullStream'];
  activity: StepActivity;
  declaredTools: Record<string, Tool>;
  report: (
    requestId: string | undefined,
    modelId: string | undefined,
    usage: Record<string, number> | undefined,
    providerResults: readonly ProviderToolResult[],
  ) => Promise<void>;
}): AsyncIterable<InferenceStreamEvent> {
  const { request, parts, activity, declaredTools } = input;
  let call: { kind: 'tool'; toolId: string; input: unknown } | undefined;
  let finished = false;
  let requestId: string | undefined;
  let modelId: string | undefined;
  const providerResults: ProviderToolResult[] = [];
  for await (const part of parts) {
    activity.observe(part);
    request.signal.throwIfAborted();
    if (part.type === 'text-delta' && part.text) {
      if (call) throw new InferenceProtocolError('Inference mixed a tool call with response text');
      yield { kind: 'text-delta', delta: part.text };
    } else if (part.type === 'tool-call' && part.providerExecuted) {
      // A provider-executed call (web search) runs inside this step and is never an OVO reply.
      continue;
    } else if (part.type === 'tool-result' && part.providerExecuted) {
      providerResults.push({ toolName: part.toolName, output: part.output });
    } else if (part.type === 'tool-call') {
      // Text then one tool call is a valid step: the agent says its answer and then calls
      // `resume_flow` or `end_call` (AGT-7, AGT-3). The behaviour decides which tool may follow
      // text; a tool call followed by text is still refused below.
      if (call)
        throw new InferenceProtocolError(
          'Inference returned multiple tool calls in a single OVO step',
        );
      if (!Object.hasOwn(declaredTools, part.toolName))
        throw new InferenceProtocolError(`Inference returned undeclared tool: ${part.toolName}`);
      call = { kind: 'tool', toolId: part.toolName, input: part.input };
    } else if (part.type === 'finish-step') {
      requestId = part.response.headers?.['x-request-id'] ?? part.response.id;
      modelId = part.response.modelId;
    } else if (part.type === 'error') {
      throw part.error;
    } else if (part.type === 'abort') {
      throw new DOMException('Inference cancelled', 'AbortError');
    } else if (part.type === 'finish') {
      const usage = compactUsage(part.totalUsage);
      await input.report(requestId, modelId, usage, providerResults);
      if (call) yield call;
      yield { kind: 'finish', ...(usage ? { usage } : {}) };
      finished = true;
    }
  }
  if (!finished) throw new InferenceProtocolError('Inference stream ended without a finish event');
}
