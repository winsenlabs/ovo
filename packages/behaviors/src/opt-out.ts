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
 * Hindi and Tamil, in the normalized form `normalizeUtterance` produces (no apostrophes). A match
 * lists the number permanently, so a phrase that merely defers the call is vetoed by
 * `DEFERRAL_MARKERS` below unless the caller also names the list or says "ever".
 */
const BUILT_IN_PHRASES = words([
  // English.
  'stop calling|stop these calls|stop phoning me|never call me|unsubscribe me|do not call list',
  'dont call me again|do not call me again|dont call me anymore|do not call me anymore',
  'dont call me ever|dont ever call me|dont call this number|do not call this number',
  'remove my number|take my number off|take me off your list|remove me from your list',
  // Hinglish.
  'mujhe call mat karo|mujhe call mat karna|mujhe call mat kijiye|mujhe phone mat karo',
  'mujhe phone mat karna|dobara call mat|dubara call mat|phir se call mat|dobara phone mat',
  'call karna band karo|call karna band kar do|phone karna band karo|mera number hata do',
  'kabhi call mat|kabhi bhi call mat|kabhi phone mat|kabhi bhi phone mat',
  // Hindi.
  'मुझे कॉल मत करो|मुझे कॉल मत करना|मुझे फोन मत करो|मुझे फ़ोन मत करो|दोबारा कॉल मत',
  'दोबारा फोन मत|फिर से कॉल मत|कॉल करना बंद करो|फोन करना बंद करो|मेरा नंबर हटा दो',
  'कभी कॉल मत|कभी भी कॉल मत|कभी फोन मत|कभी भी फोन मत',
  // Tamil.
  'inimel call pannadheenga|thirumba call pannadheenga|இனிமேல் கால் பண்ணாதீங்க',
  'திரும்ப கால் பண்ணாதீங்க',
]);

/**
 * Words that make "don't call me" mean "not now": a time, a later moment or being busy ("abhi
 * mujhe call mat karo, main busy hoon", "dont call me again today, I will pay tomorrow", "never
 * call me before 10am"). Any of them vetoes an opt-out phrase; the turn then goes to the agent as
 * an ordinary reply, which can offer a callback. A missed opt-out is recoverable on the next turn,
 * a wrong one permanently stops a customer who asked to be called later.
 */
const DEFERRAL_MARKERS = words([
  'now|right now|abhi|abhi ke liye|ippo|ippodhu|अभी|today|tonight|aaj|आज|this week|this month',
  'later|baad mein|baad me|baadme|बाद में|aprom|appuram|tomorrow|kal|कल|parso|naalaikku|nalaikku',
  'next week|next month|weekend|morning|afternoon|evening|night|subah|shaam|sham|raat|सुबह|शाम',
  'रात|busy|बिज़ी|बिजी|at work|office|ऑफिस|meeting|driving|working hours|office time|office hours',
  'am|pm|baje|बजे|oclock|minutes',
]);
/**
 * Clock times: "10am", "5baje", or before/after/until a time ("before 10", "after lunch"). A bare
 * "before" is not a deferral: "I told you before, stop calling me" still opts out.
 */
const CLOCK_TIME =
  /(?:^| )(?:\d{1,2}(?:am|pm|baje)|(?:before|after|until|till|by) (?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|lunch))(?= |$)/u;

/** Unmistakably permanent asks: these opt out even alongside a deferral word. */
const PERMANENT_MARKERS = words([
  'ever|forever|anymore|never again|from now on|kabhi|kabhi bhi|कभी|कभी भी|ab se|अब से',
  'aaj ke baad|आज के बाद|inimel|இனிமேல்|do not call list|your list|my number|this number',
  'mera number|मेरा नंबर|unsubscribe me',
]);

function words(groups: readonly string[]): string[] {
  return groups.flatMap((group) => group.split('|')).map(normalizeUtterance);
}

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

/**
 * True when `text` asks not to be called again: a built-in or authored phrase, as whole words, and
 * no deferral word unless a permanent marker ("ever", "kabhi", the list, the number) is said too.
 */
export function detectsOptOut(text: string, phrases: readonly string[] = []): boolean {
  const utterance = ` ${normalizeUtterance(text)} `;
  if (utterance.trim() === '') return false;
  const says = (phrase: string) => phrase !== '' && utterance.includes(` ${phrase} `);
  if (![...BUILT_IN_PHRASES, ...phrases.map(normalizeUtterance)].some(says)) return false;
  const defers = DEFERRAL_MARKERS.some(says) || CLOCK_TIME.test(utterance.trim());
  return !defers || PERMANENT_MARKERS.some(says);
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
