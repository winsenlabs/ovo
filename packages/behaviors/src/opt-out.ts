import type { EventSink } from '@winsendotai/ovo-contracts';
import { recordSessionEvent } from './outcome-events.ts';
import { normalizeUtterance } from './rules-lexicons.ts';

/** The disposition a caller's opt-out records, and the agent's completion reason for it. */
export const OPT_OUT_DISPOSITION = 'opted_out';
export const OPT_OUT_COMPLETION = 'opt_out';
/** The contract's default (`DEFAULT_OPT_OUT_CLOSING_LINE` in contracts agent-compliance.ts). */
const DEFAULT_CLOSING_LINE = "Understood. We won't call this number again. Thank you, goodbye.";

/**
 * Ways callers on Indian collections calls ask not to be called again, matched as whole words
 * anywhere in the utterance ("please stop calling me, I already paid" opts out). English, Hinglish,
 * Hindi and Tamil, in the normalized form `normalizeUtterance` produces (no apostrophes). Narrow by
 * design: "don't call me now" and "abhi call mat karo" defer the call, they do not opt out, so a
 * phrase must say "again", "ever", name the list or address the caller ("mujhe").
 */
const BUILT_IN_PHRASES = [
  'stop calling',
  'stop these calls',
  'stop phoning me',
  'dont call me again',
  'do not call me again',
  'dont call me anymore',
  'do not call me anymore',
  'dont call me ever',
  'dont ever call me',
  'never call me',
  'dont call this number',
  'do not call this number',
  'remove my number',
  'take my number off',
  'take me off your list',
  'remove me from your list',
  'do not call list',
  'unsubscribe me',
  'mujhe call mat karo',
  'mujhe call mat karna',
  'mujhe call mat kijiye',
  'mujhe phone mat karo',
  'mujhe phone mat karna',
  'dobara call mat',
  'dubara call mat',
  'phir se call mat',
  'dobara phone mat',
  'call karna band karo',
  'call karna band kar do',
  'phone karna band karo',
  'mera number hata do',
  'मुझे कॉल मत करो',
  'मुझे कॉल मत करना',
  'मुझे फोन मत करो',
  'मुझे फ़ोन मत करो',
  'दोबारा कॉल मत',
  'दोबारा फोन मत',
  'फिर से कॉल मत',
  'कॉल करना बंद करो',
  'फोन करना बंद करो',
  'मेरा नंबर हटा दो',
  'inimel call pannadheenga',
  'thirumba call pannadheenga',
  'இனிமேல் கால் பண்ணாதீங்க',
  'திரும்ப கால் பண்ணாதீங்க',
].map(normalizeUtterance);

/** `AgentConfig.compliance.optOut` as the contract parses it; read structurally. */
export interface OptOutPolicy {
  enabled: boolean;
  phrases: readonly string[];
  closingLine: string;
}

/** The agent's opt-out policy, or undefined when it has none or turned it off. */
export function optOutPolicy(config: unknown): OptOutPolicy | undefined {
  const block = (config as { compliance?: { optOut?: Partial<OptOutPolicy> } } | undefined)
    ?.compliance?.optOut;
  if (!block || block.enabled === false) return undefined;
  return {
    enabled: true,
    phrases: Array.isArray(block.phrases) ? block.phrases : [],
    closingLine:
      typeof block.closingLine === 'string' && block.closingLine.trim()
        ? block.closingLine
        : DEFAULT_CLOSING_LINE,
  };
}

/** True when `text` asks not to be called again: a built-in or authored phrase, as whole words. */
export function detectsOptOut(text: string, phrases: readonly string[] = []): boolean {
  const utterance = ` ${normalizeUtterance(text)} `;
  if (utterance.trim() === '') return false;
  return [...BUILT_IN_PHRASES, ...phrases.map(normalizeUtterance)].some(
    (phrase) => phrase !== '' && utterance.includes(` ${phrase} `),
  );
}

/**
 * One call's opt-out (collections compliance). When the caller asks not to be called again, the
 * agent says the closing line and ends the call; `optedOut` tells the host to put the number on the
 * do-not-call list, and the `opted_out` disposition is recorded with the rules tier as its source.
 * It wins over every other route, a pending confirmation included: the caller has withdrawn consent.
 */
export class CallOptOut {
  private readonly policy?: OptOutPolicy;
  private heardAt?: number;

  constructor(
    config: unknown,
    private readonly sink?: EventSink,
  ) {
    this.policy = optOutPolicy(config);
  }

  /** True once the caller has opted out on this call. */
  get optedOut(): boolean {
    return this.heardAt !== undefined;
  }

  get closingLine(): string {
    return this.policy?.closingLine ?? DEFAULT_CLOSING_LINE;
  }

  /** Judges a caller turn; records the disposition the first time the caller opts out. */
  heard(input: string, turn: number): boolean {
    if (!this.policy || !detectsOptOut(input, this.policy.phrases)) return false;
    if (this.heardAt === undefined) {
      this.heardAt = turn;
      recordSessionEvent(this.sink, 'disposition', {
        disposition: OPT_OUT_DISPOSITION,
        turn,
        source: 'rule',
        reason: 'caller_opt_out',
      });
    }
    return true;
  }
}
