import type { ToolDefinition } from '@winsendotai/ovo-contracts';
import type { InferenceStepInput } from './agent-inference-step.ts';
import { flowGuide, flowResumeTool, type FlowResume } from './flow-rejoin.ts';
import { INTERRUPTED_CONTEXT } from './history.ts';
import { saidUncertainty, uncertaintyNote } from './inference-recovery.ts';
import type { InferenceCall } from './speculation-llm.ts';

/*
 * The request a turn sends the LLM: the briefing, the notes about how the call stands (a reply the
 * caller cut off, an uncertainty line just said), and the flow's resume offer when it has one.
 */

/** How the flow is offered to the LLM for one turn. */
export interface RejoinOffer {
  tool: ToolDefinition;
  guide: string;
}

/** ...and what the LLM did with it. */
export interface Rejoin extends RejoinOffer {
  resume(input: Pick<FlowResume, 'resumeAt' | 'action'>): void;
}

export type RequestInput = Pick<
  InferenceStepInput,
  | 'config'
  | 'input'
  | 'history'
  | 'context'
  | 'tools'
  | 'results'
  | 'flow'
  | 'replyCut'
  | 'previous'
>;

export function rejoinOffer({ config, flow }: RequestInput): RejoinOffer | undefined {
  const endAllowed = Boolean(config.ending?.llmTool);
  const tool = flow ? flowResumeTool(flow, endAllowed) : undefined;
  return flow && tool ? { tool, guide: flowGuide(flow, endAllowed) } : undefined;
}

export function inferenceRequest(
  step: RequestInput,
  rejoin: RejoinOffer | undefined,
): InferenceCall {
  const notes = [
    step.replyCut ? INTERRUPTED_CONTEXT : '',
    saidUncertainty(step) ? uncertaintyNote(step.config.uncertainty) : '',
    rejoin?.guide ?? '',
  ].filter(Boolean);
  return {
    input: step.input,
    history: step.history,
    context: notes.length ? [step.context, ...notes].filter(Boolean).join('\n\n') : step.context,
    uncertainty: step.config.uncertainty,
    tools: rejoin ? [...step.tools, rejoin.tool] : step.tools,
    results: step.results,
  };
}

/**
 * The first request `runInferenceSteps` will send for a turn in the flow state the call is in now.
 * LAT-3 asks it while the decision is still deciding; the step reuses that answer only when its own
 * first request turns out the same.
 */
export function firstInferenceRequest(step: RequestInput): InferenceCall {
  return inferenceRequest(step, rejoinOffer(step));
}
