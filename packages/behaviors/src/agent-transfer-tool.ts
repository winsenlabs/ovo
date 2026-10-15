import {
  baseLanguageOf,
  TRANSFER_BUILT_IN_LINES,
  TRANSFER_TO_AGENT_TOOL_ID,
  type AgentTransferRefusal,
  type ToolDefinition,
  type TransferTargetOffer,
} from '@winsendotai/ovo-contracts';

/**
 * R2: offered to the LLM on a routed call whose routing point grants this agent transfer targets.
 * Like `end_call` it never reaches a connector: the behaviour asks the host to begin the transfer
 * and, once it is accepted, speaks the announcement itself as the turn's whole reply. The model
 * picks a catalogue key (an enum); it can never name a release, pool or node.
 */
export function transferToAgentTool(
  offers: readonly TransferTargetOffer[],
  summary: boolean,
): ToolDefinition {
  return {
    id: TRANSFER_TO_AGENT_TOOL_ID,
    description:
      'Transfer the caller to another team when they need something you cannot handle. Call this ' +
      'first, before saying anything. Then say nothing; the transfer line is played for you.',
    connector: 'native',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: summary ? ['target', 'summary'] : ['target'],
      properties: {
        target: {
          type: 'string',
          enum: offers.map((offer) => offer.key),
          description: offers.map((offer) => `${offer.key}: ${offer.description}`).join(' | '),
        },
        reason: { type: 'string', maxLength: 200 },
        ...(summary
          ? {
              summary: {
                type: 'string',
                maxLength: 1_000,
                description:
                  'What the caller needs and what you already know, for the colleague who takes over.',
              },
            }
          : {}),
        confirmed: {
          type: 'boolean',
          description: 'Only after the caller said yes to being transferred.',
        },
      },
    },
    effect: 'read',
    confirmation: false,
    timeoutMs: 2_000,
  };
}

/** The tool's input, read after its schema accepted it. */
export function transferInput(input: unknown) {
  const raw = input as Record<string, unknown>;
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
  const reason = text(raw.reason, 200);
  const summary = text(raw.summary, 1_000);
  return {
    key: String(raw.target),
    ...(reason ? { reason } : {}),
    ...(summary ? { summary } : {}),
    claimed: raw.confirmed === true,
  };
}

/**
 * The confirm question for a target whose confirm is `ask`, in the agent's base language: the
 * built-in en/hi line with the target's label (already in that language), else its key humanised.
 */
export function confirmQuestion(offer: TransferTargetOffer, language: string): string {
  const lines: Readonly<Record<string, string>> = TRANSFER_BUILT_IN_LINES.confirm;
  const line = lines[baseLanguageOf(language)] ?? lines.en!;
  return line.replace('{label}', offer.label ?? offer.key.replace(/[_-]+/g, ' '));
}

/** What the model is told when a transfer did not happen, so its next step can act on it. */
export const TRANSFER_DECLINED =
  'The caller declined the transfer. Do not transfer; help them yourself.';

export function refusalInstruction(reason: AgentTransferRefusal): string {
  // R3: the codes a human queue's gates refuse with (the contracts carry them from R3).
  const code: string = reason;
  switch (code) {
    case 'queue_closed':
      return 'The team that takes that call is closed right now. Tell the caller, and help them yourself or offer a callback.';
    case 'no_operators':
    case 'queue_full':
      return 'No colleague is free to take the call right now. Tell the caller, and help them yourself or offer a callback.';
    case 'queue_unavailable':
    case 'queue_unknown':
      return 'That team cannot be reached right now. Help the caller yourself or offer a callback.';
    case 'busy':
    case 'pool_full':
    case 'no_eligible_member':
      return 'Nobody on that team can take the call right now. Tell the caller, and help them yourself or offer a callback.';
    case 'not_confirmed':
      return 'The caller has not agreed to the transfer. Ask them first.';
    case 'call_ended':
      return 'The call is ending. Say nothing more about a transfer.';
    default:
      return 'That transfer is not available. Help the caller yourself or offer a callback.';
  }
}
