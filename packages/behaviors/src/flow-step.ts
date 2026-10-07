import { AnnouncementValidationError } from './announcement.ts';
import type { FlowLine, FlowSession, FlowStep } from './flow-session.ts';

export interface AppliedFlowStep {
  /** Each rendered line, in order, so a cached line is spoken as its own segment. */
  lines?: string[];
  /** The lines joined, for callers that speak one text. */
  speak?: string;
  /** The call ends once this turn's reply has played; `flow:<node>`. */
  end?: string;
  /**
   * Per line of `lines`, the id of a mandatory line the caller must hear in full (P5); the agent
   * reports each one's playback to `FlowSession.heard`.
   */
  mandatory?: (string | undefined)[];
  /**
   * The lines restate rather than say something new (a repeat, a hold, a clarification, a node
   * said again), so a later repeat does not replay them.
   */
  replay?: boolean;
}

/**
 * Render a step's lines with this call's variables, commit it, and say what the turn speaks.
 *
 * A line this call's data cannot fill is skipped and recorded on the transition by id only, never
 * with a value, exactly as an opening line is: bad row data must not hang up on someone. With no
 * line left to say, the turn has nothing scripted and the LLM composes the reply, which is also how
 * a node authored without lines hands one turn to the LLM.
 */
export function applyFlowStep(
  flow: FlowSession,
  step: FlowStep,
  options: { render: (template: string) => string; clarification: string },
): AppliedFlowStep {
  if (step.kind === 'fallback') {
    flow.commit(step);
    if (step.action === 'llm') return {};
    const line = step.line ? renderFlowLines([step.line], options.render).lines[0] : undefined;
    const text = line ?? options.clarification;
    return { lines: [text], speak: text, replay: true };
  }
  const { lines, ids, skipped } = renderFlowLines(step.lines, options.render);
  flow.commit(step, skipped);
  const end = step.kind === 'enter' && step.end ? { end: `flow:${step.node}` } : {};
  if (!lines.length) return end;
  const unheard = flow.unheardLines;
  const mandatory = ids.map((id) => (unheard.includes(id) ? id : undefined));
  return {
    lines,
    speak: lines.join(' '),
    ...end,
    ...(mandatory.some(Boolean) ? { mandatory } : {}),
    ...(step.kind === 'repeat' ? { replay: true } : {}),
  };
}

export function renderFlowLines(
  lines: readonly FlowLine[],
  render: (template: string) => string,
): { lines: string[]; ids: string[]; skipped: string[] } {
  const rendered: string[] = [];
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    try {
      rendered.push(line.rendered ? line.template : render(line.template));
      ids.push(line.id);
    } catch (error) {
      // swallow-ok: recorded on the transition as `skippedLines`; the rest of the node still plays.
      if (!(error instanceof AnnouncementValidationError)) throw error;
      skipped.push(line.id);
    }
  }
  return { lines: rendered, ids, skipped };
}

/**
 * A greet-first opening enters the flow's start state and speaks its lines, after any `opening`
 * lines. Undefined without a flow, or once it has started.
 */
export function openFlow(
  flow: FlowSession | undefined,
  options: { render: (template: string) => string; clarification: string },
): AppliedFlowStep | undefined {
  const start = flow?.begin();
  return start ? applyFlowStep(flow!, start, options) : undefined;
}

/** AGT-5: a flow that confirms identity withholds the LLM's call facts until it has. */
export function flowFacts(flow: FlowSession | undefined, facts: string): string {
  return flow ? flow.gateFacts(facts) : facts;
}

/**
 * AGT-5, the briefing too: until identity is confirmed it is shown as authored, placeholders and
 * all, so a briefing such as "You are calling {{full_name}} about an EMI of {{emi}}" cannot hand
 * the call's data to the LLM before a verified node is entered. `render` runs only once it may.
 */
export function flowBriefing(
  flow: FlowSession | undefined,
  briefing: string,
  render: (briefing: string) => string,
): string {
  return !flow || flow.verified ? render(briefing) : briefing;
}
