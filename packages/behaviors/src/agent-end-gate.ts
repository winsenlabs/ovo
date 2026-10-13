import {
  affirmationOnly,
  answersEnding,
  classifyConfirmation,
  declinesWithThanks,
  DEFAULT_END_CALL_MIN_CALL_SECONDS,
  DEFAULT_END_CALL_MIN_CALLER_TURNS,
  closesConversation,
  endingLines,
  normalizeForMatch,
  SAID_BEFORE_REPLY_VARIABLE,
  saysGoodbye,
  UNTRUSTED_INPUT_VARIABLE,
  type AgentConfig,
} from '@winsendotai/ovo-contracts';

// Read in contracts (caller-closing.ts) since Wave 9: the turn detector reads them too.
export { closesConversation, saysGoodbye };

/** Indian callers mix English, Hindi and their own language in any of these scripts. */
const INDIC = ['Deva', 'Taml', 'Telu', 'Knda', 'Mlym', 'Beng', 'Gujr', 'Guru', 'Orya'];
const SCRIPTS = [
  ...['Latn', ...INDIC, 'Cyrl', 'Grek', 'Arab', 'Hebr', 'Hani', 'Hira', 'Kana', 'Hang'],
  ...['Thai', 'Armn', 'Geor', 'Ethi', 'Sinh'],
].map((code) => ({ code, pattern: new RegExp(`\\p{Script=${code}}`, 'u') }));

/** The scripts a caller of an agent speaking `languages` may write: Latin, the language's own. */
function scriptsFor(languages: readonly string[]): Set<string> {
  const allowed = new Set(['Latn']);
  for (const tag of languages) {
    try {
      const locale = new Intl.Locale(tag).maximize();
      if (locale.script) allowed.add(locale.script);
      if (locale.region === 'IN') for (const code of INDIC) allowed.add(code);
    } catch {
      // An unparseable tag adds nothing; Latin is still allowed.
    }
  }
  return allowed;
}

/** True when most of the letters are in scripts outside `allowed`: STT drift, not this caller. */
export function foreignScript(text: string, allowed: ReadonlySet<string>): boolean {
  let letters = 0;
  let foreign = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    letters += 1;
    const script = SCRIPTS.find(({ pattern }) => pattern.test(char))?.code;
    if (!script || !allowed.has(script)) foreign += 1;
  }
  return letters > 0 && foreign * 2 > letters;
}

/**
 * Wave 8b: what the agent asks when it may want to end the call but the caller has not clearly
 * asked to, or was not heard clearly (Maya call e8a43f65: "Ma'am, create a call." ended it). A yes
 * to it ends the call. English and Hindi agents have it (contracts `endingLines`); any other the
 * model asks in its words.
 */
export function askToEndLine(language: string): string | undefined {
  return endingLines(language)?.ask;
}

export const END_REFUSED = {
  unheard: 'the caller was not heard clearly',
  early: 'the conversation has only just started',
  unasked: 'the caller has not clearly asked to end the call',
  // Wave 10 (B1): never asked about; the model answers the words instead.
  beforeReply: 'the caller said this before hearing your last reply',
} as const;

/** Words said before the caller heard the agent's last reply (`SAID_BEFORE_REPLY_VARIABLE`). */
export function saidBeforeReply(variables: Readonly<Record<string, unknown>>): string | undefined {
  const earlier = variables[SAID_BEFORE_REPLY_VARIABLE];
  return typeof earlier === 'string' && earlier.trim() ? earlier : undefined;
}

/**
 * A yes to the agent's question, however it goes on ("Yes.", "Haan ji, end it."): the model still
 * decides whether to end the call; this only lets it.
 */
function saysYes(text: string): boolean {
  if (classifyConfirmation(text) === 'no') return false;
  const first = normalizeForMatch(text).split(' ')[0] ?? '';
  return affirmationOnly(text) || affirmationOnly(first);
}

/**
 * N1: whether the LLM may end the call on this turn. A model that hangs up on a misheard first
 * turn, or on a caller still finding their words, loses the call, so `end_call` waits for
 * `minCallerTurns` turns and `minCallSeconds`, unless the caller says goodbye; and it never acts
 * on words that are untrusted: flagged by `UNTRUSTED_INPUT_VARIABLE`, or mostly in a script the
 * agent's language does not use (Russian heard on a Hinglish call). Untrusted turns do not count.
 * Wave 8b: past the minimums it still ends only on a clear goodbye or ask to end the call, or a
 * yes to the agent's own `askToEndLine` (call e8a43f65 hung up on "Ma'am, create a call.").
 * Wave 9: or on a closing (`closesConversation`), which is asked about only before the minimums.
 * Wave 10 (Maya call 4f1a919d): a decline with thanks that answers the agent's question or offer
 * ("No, okay, I'll take it later. Thank you so much.", B3) is a closing too; and words said before
 * the caller heard the agent's last reply (B1: "Madras." queued 17.8 s behind the answer to
 * "Chennai, Chennai.") answer nothing in it, so they end the call only on a goodbye, and a yes
 * among them is no yes to the agent's question.
 */
export class EndCallGate {
  private callerTurns = 0;
  /** The words of the last turn counted. */
  private last = '';
  /** Wave 10 (L2): the reason of the model's `end_call` the agent asked about, this turn and last. */
  private askedReason?: string;
  private lastAsked?: string;
  private readonly startedAt: number;
  private readonly scripts: Set<string>;

  constructor(
    private readonly config: Pick<AgentConfig, 'ending' | 'language' | 'locale'>,
    private readonly now: () => number,
  ) {
    this.startedAt = now();
    this.scripts = scriptsFor([config.language, config.locale]);
  }

  /**
   * A caller turn is being answered, after the agent's `previous` lines. Returns why `end_call` is
   * refused on it, if it is.
   */
  turn(
    input: string,
    variables: Readonly<Record<string, unknown>>,
    previous: readonly string[] = [],
  ): string | undefined {
    this.lastAsked = this.askedReason;
    this.askedReason = undefined;
    if (this.untrusted(input, variables)) return END_REFUSED.unheard;
    // AGT-10: a reply the caller spoke over before hearing any of it is run again on both
    // utterances together, which carry on the words already counted: still one caller turn. (Words
    // said again in a turn of their own count once too; the gate only ever waits longer for it.)
    const words = normalizeForMatch(input);
    if (!this.last || (words !== this.last && !words.startsWith(`${this.last} `)))
      this.callerTurns += 1;
    this.last = words;
    if (saysGoodbye(input)) return undefined;
    if (saidBeforeReply(variables)) return END_REFUSED.beforeReply;
    if (this.askedToEnd(previous) && saysYes(input)) return undefined;
    const ending = this.config.ending;
    const turns = ending?.minCallerTurns ?? DEFAULT_END_CALL_MIN_CALLER_TURNS;
    const seconds = ending?.minCallSeconds ?? DEFAULT_END_CALL_MIN_CALL_SECONDS;
    if (this.callerTurns < turns || this.now() - this.startedAt < seconds * 1000)
      return END_REFUSED.early;
    const closes =
      closesConversation(input) || (declinesWithThanks(input) && askedOrOffered(previous));
    return closes ? undefined : END_REFUSED.unasked;
  }

  /**
   * Wave 10 (L2): the caller's answer to the agent's own `askToEndLine`, when it is a plain yes or
   * no (`answersEnding`) the agent can answer without the model: in call 4f1a919d "Yeah, yeah."
   * waited 1.58 s for the model, and heard "One moment." first, to be told goodbye. Never for
   * words that are untrusted or were said before the question was heard.
   */
  answeredAsk(
    input: string,
    variables: Readonly<Record<string, unknown>>,
    previous: readonly string[],
  ): 'yes' | 'no' | undefined {
    if (this.untrusted(input, variables) || saidBeforeReply(variables)) return undefined;
    return this.askedToEnd(previous) ? answersEnding(input) : undefined;
  }

  /** The agent asked `askToEndLine` in place of the model's `end_call`, which gave `reason`. */
  asked(reason: string): void {
    this.askedReason = reason;
  }

  /**
   * The fixed line `answeredAsk` gets, read after `turn`: a yes is told goodbye and ends the call
   * (`end`, the reason of the model's `end_call` that was asked about); a no carries on.
   */
  fixedReply(
    input: string,
    variables: Readonly<Record<string, unknown>>,
    previous: readonly string[],
  ): { line: string; end?: string } | undefined {
    const answer = this.answeredAsk(input, variables, previous);
    const lines = answer && endingLines(this.config.language);
    if (!lines) return undefined;
    if (answer === 'no') return { line: lines.resume };
    return { line: lines.goodbye, end: this.lastAsked ?? 'llm:end_call' };
  }

  private untrusted(input: string, variables: Readonly<Record<string, unknown>>): boolean {
    return variables[UNTRUSTED_INPUT_VARIABLE] === true || foreignScript(input, this.scripts);
  }

  /** The agent's last line asked whether to end the call. */
  private askedToEnd(previous: readonly string[]): boolean {
    const asked = askToEndLine(this.config.language);
    const last = previous.at(-1);
    return Boolean(asked && last && normalizeForMatch(last) === normalizeForMatch(asked));
  }
}

/** The agent's last turn asked the caller something or offered something ("Want more detail?"). */
function askedOrOffered(previous: readonly string[]): boolean {
  return previous.some((line) => /[?？]/u.test(line));
}
