import { z } from 'zod';
import type { AgentFlow } from './agent-flow.ts';
import { flowSpeaksFirst } from './agent-flow-compile.ts';

/**
 * How an agent starts and ends a call: the opening it speaks before the caller says anything, what
 * it does when an outbound call reaches an answering machine, and whether the LLM may end the call.
 *
 * Every line here is a template. `{{path}}` renders from the call's variables, and a path must be
 * declared by `AgentConfig.variables` or be one of `AGENT_BUILTIN_VARIABLES`; release creation
 * rejects any other path (`template_variable_undeclared`). A line with no placeholder never changes
 * between calls, which is what lets it be rendered once and served from the clip cache.
 */

const Line = z.string().trim().min(1).max(1_000);

/** Variables every agent template can read without declaring them, in the agent's own timezone. */
export const AGENT_BUILTIN_VARIABLES = ['today', 'date_tomorrow', 'date_week'] as const;
export type AgentBuiltinVariable = (typeof AGENT_BUILTIN_VARIABLES)[number];

/**
 * Spoken first, as soon as the call connects, with no decision or LLM round trip. Its presence is
 * what makes an agent greet first; an agent without one waits for the caller as it always has.
 */
export const AgentOpening = z
  .object({
    /** Spoken in order. Several short lines let a cached greeting start before a personal line. */
    lines: z.array(Line).min(1).max(5),
  })
  .strict();
export type AgentOpening = z.infer<typeof AgentOpening>;

/**
 * A human is usually classified 2-3 seconds after answering. A machine is classified only once its
 * greeting ends, so it outlasts this and is handled when its verdict arrives, mid-opening if need be.
 */
export const DEFAULT_VOICEMAIL_TIMEOUT_MS = 4_000;

/**
 * Answering-machine handling on outbound calls. The carrier is asked to detect a machine, and the
 * opening waits for its verdict (up to `timeoutMs`) so a greeting is never spent on a voicemail
 * box. A machine ends the call with the `voicemail` outcome, after `message` when one is set.
 *
 * An outbound agent with an opening and no `voicemail` block gets the defaults below: detect, wait
 * up to `timeoutMs`, and hang up on a machine. Inbound calls are never held.
 */
export const AgentVoicemail = z
  .object({
    detect: z.boolean().default(true),
    /** Longest the opening waits for the verdict before speaking anyway. */
    timeoutMs: z.number().int().min(500).max(30_000).default(DEFAULT_VOICEMAIL_TIMEOUT_MS),
    action: z.enum(['hangup', 'message']).default('hangup'),
    /** Left on the machine when `action` is `message`. */
    message: Line.optional(),
  })
  .strict()
  .refine((policy) => policy.action !== 'message' || policy.message !== undefined, {
    message: 'A voicemail message action needs the message to leave',
    path: ['message'],
  });
export type AgentVoicemail = z.infer<typeof AgentVoicemail>;

/**
 * The voicemail policy that applies when an outbound agent configures none. A flow whose start
 * node has lines greets first exactly as an opening does, so it gets the same default.
 */
export function effectiveVoicemailPolicy(config: {
  voicemail?: AgentVoicemail;
  opening?: AgentOpening;
  decision?: { enabled: boolean; flow?: AgentFlow };
}): AgentVoicemail | undefined {
  if (config.voicemail) return config.voicemail.detect ? config.voicemail : undefined;
  return config.opening || flowSpeaksFirst(config.decision)
    ? { detect: true, timeoutMs: DEFAULT_VOICEMAIL_TIMEOUT_MS, action: 'hangup' }
    : undefined;
}

/** The tool id the LLM calls to end the call. Reserved: an authored tool cannot reuse it. */
export const END_CALL_TOOL_ID = 'end_call';

/**
 * A graceful end at the call time limit (`costPolicy.maxCallSeconds`). `leadSeconds` before the
 * limit the agent stops taking turns, lets the line it is saying finish, speaks `line` and ends the
 * call completed (end detail `max_duration`) instead of being cut off mid-sentence at the limit.
 * The engine speaks it without a behaviour, so it is a fixed line with no placeholder, rendered
 * once into the release's clips.
 */
export const AgentWrapUp = z
  .object({
    line: Line.refine((line) => !/{{|}}/.test(line), {
      message: 'The wrap-up line is spoken as written and cannot use {{variables}}',
    }),
    leadSeconds: z.number().int().min(5).max(120).default(15),
  })
  .strict();
export type AgentWrapUp = z.infer<typeof AgentWrapUp>;

/** N1: `end_call` is refused before the caller has taken this many turns, */
export const DEFAULT_END_CALL_MIN_CALLER_TURNS = 2;
/** ...and before the call has run this long, unless the caller says goodbye. */
export const DEFAULT_END_CALL_MIN_CALL_SECONDS = 20;

/**
 * N1: a caller turn's variable, set true by whatever judged its transcript untrustworthy (low STT
 * confidence, a language the agent does not speak). Such a turn can never end the call.
 */
export const UNTRUSTED_INPUT_VARIABLE = 'inputUntrusted';

export const AgentEnding = z
  .object({
    /**
     * Offer the LLM a built-in `end_call` tool. Its `goodbye` is spoken, and the call ends once it
     * has played. Off by default: a model that hangs up mid-flow loses the call.
     */
    llmTool: z.boolean().default(false),
    /**
     * N1: the LLM's `end_call` is refused (the model is told so and answers instead) until the
     * caller has taken `minCallerTurns` turns and the call has run `minCallSeconds`, unless the
     * caller says goodbye. Never on a turn whose words are untrusted (`UNTRUSTED_INPUT_VARIABLE`,
     * or written in a script the agent's language does not use), nor right after the agent asked a
     * question. Defaults: `DEFAULT_END_CALL_MIN_CALLER_TURNS`, `DEFAULT_END_CALL_MIN_CALL_SECONDS`;
     * 0 lifts either minimum.
     */
    minCallerTurns: z.number().int().min(0).max(50).optional(),
    minCallSeconds: z.number().int().min(0).max(3_600).optional(),
    wrapUp: AgentWrapUp.optional(),
  })
  .strict();
export type AgentEnding = z.infer<typeof AgentEnding>;
