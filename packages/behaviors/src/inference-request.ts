import {
  affirmationOnly,
  baseLanguageOf,
  normalizeForMatch,
  seeksInformation,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import type { InferenceStepInput } from './agent-inference-step.ts';
import { flowGuide, flowResumeTool, type FlowResume } from './flow-rejoin.ts';
import { INTERRUPTED_CONTEXT } from './history.ts';
import { replyLanguageNote } from './language-guard.ts';
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
  | 'saidBefore'
>;

export function rejoinOffer({ config, flow }: RequestInput): RejoinOffer | undefined {
  const endAllowed = Boolean(config.ending?.llmTool);
  const tool = flow ? flowResumeTool(flow, endAllowed) : undefined;
  return flow && tool ? { tool, guide: flowGuide(flow, endAllowed) } : undefined;
}

/**
 * Wave 9 D1 (call 10d5ef30): write for the ear. plugin-voice's speech normaliser guarantees it on
 * the way to TTS; this asks the model to write that way first. Fixed for the call, so it stays in
 * the prompt's cached prefix (N4).
 * Wave 12 (call 8cb76efc): short sentences without semicolons (F5: turn 7's 184-character sentence
 * played for 12 s with a second of dead air in it), and no offer of more at the end, which the reply
 * cap makes now and then (F7: nearly every answer of the call ended "Would you like…?").
 */
export function voiceStyleNote(config: { language: string }): string | undefined {
  if (baseLanguageOf(config.language) !== 'en') return undefined;
  const dates = /^en-US$/i.test(config.language)
    ? ''
    : 'say dates day first ("the 21st of December"); ';
  return (
    'Your replies are spoken on a phone call, so write for the ear: no dashes, symbols or ' +
    'abbreviations; say ranges with "to" ("Chennai to Prague", "the 21st to the 24th of December", ' +
    `"between seventy thousand and one lakh rupees"); ${dates}leave out the year unless the date ` +
    'is more than a year away. Keep sentences short, without semicolons. End a reply when it has ' +
    'answered: do not offer more detail or ask whether the caller wants more, and ask a question ' +
    'only when you need their answer to go on.'
  );
}

export function inferenceRequest(
  step: RequestInput,
  rejoin: RejoinOffer | undefined,
): InferenceCall {
  const notes = [
    // First: fixed for the call, so the prompt's cached prefix ends after it (N4).
    replyLanguageNote(step.config) ?? '',
    voiceStyleNote(step.config) ?? '',
    step.replyCut ? INTERRUPTED_CONTEXT : '',
    saidUncertainty(step) ? uncertaintyNote(step.config.uncertainty) : '',
    affirmationNote(step) ?? '',
    saidBeforeNote(step) ?? '',
    rejoin?.guide ?? '',
  ].filter(Boolean);
  return {
    input: step.input,
    history: step.history,
    context: notes.length ? [step.context, ...notes].filter(Boolean).join('\n\n') : step.context,
    uncertainty: step.config.uncertainty,
    tools: rejoin ? [...step.tools, rejoin.tool] : step.tools,
    results: step.results,
    // Wave 10 (B1): words that only add to ones the reply just answered (and searched for) carry
    // nothing new to look up; words that ask something keep the search.
    ...(step.saidBefore && !seeksInformation(step.input) ? { providerTools: false as const } : {}),
  };
}

/**
 * call-3 #3: a bare yes ("haan", "हाँ", "ji", "Yes.") answers the agent's last question. In Maya
 * call 6e1a4e3a the model answered "हाँ।", said to "Where are you thinking of going?", with the
 * uncertainty line. Quotes the words as `normalizeForMatch` reads them, so a partial and a final
 * transcript that differ only in punctuation get the same request (Wave 8 speculation).
 */
function affirmationNote({ input, previous }: RequestInput): string | undefined {
  const question = [...(previous ?? [])].reverse().find((line) => /[?？]/u.test(line));
  if (!question || !affirmationOnly(input)) return undefined;
  return (
    `The caller's "${normalizeForMatch(input)}" means yes, in answer to your last question ` +
    `("${question.trim()}"). Carry on from that answer; if a yes does not answer it, ask the ` +
    'question again in a few words. Do not say you are unsure.'
  );
}

/**
 * Wave 10 (Maya call 4f1a919d, B1): the caller said "Madras." a second after "Chennai, Chennai.",
 * while the answer to that searched, and heard it only after the whole answer had played (17.8 s
 * later, ending "Which European city are you heading to, and when?"). Asked then as a turn of its
 * own, the model took it for an answer and ended the call. Told when the words were said, it reads
 * them with the earlier ones.
 */
function saidBeforeNote({ input, saidBefore }: RequestInput): string | undefined {
  if (!saidBefore) return undefined;
  return (
    `The caller said "${input.trim()}" straight after "${saidBefore.trim()}", before they heard ` +
    'your reply to that: these words add to what they had said and answer nothing in your reply. ' +
    'Read them that way; if they change nothing you said, acknowledge them in a few words.'
  );
}

/**
 * The first request `runInferenceSteps` will send for a turn in the flow state the call is in now.
 * LAT-3 asks it while the decision is still deciding; the step reuses that answer only when its own
 * first request turns out the same.
 */
export function firstInferenceRequest(step: RequestInput): InferenceCall {
  return inferenceRequest(step, rejoinOffer(step));
}
