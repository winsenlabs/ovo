import {
  affirmationOnly,
  baseLanguageOf,
  classifyConfirmation,
  DEFAULT_END_CALL_MIN_CALL_SECONDS,
  DEFAULT_END_CALL_MIN_CALLER_TURNS,
  normalizeForMatch,
  UNTRUSTED_INPUT_VARIABLE,
  type AgentConfig,
} from '@winsendotai/ovo-contracts';

/**
 * What callers say to end a call themselves, as STT writes it: English, Hinglish and Hindi, then
 * Tamil; then (Wave 8b) asking the agent outright to end it. Matched as whole words anywhere in
 * the turn ("ok thank you bye", "Maya, cut the call").
 */
const GOODBYES = [
  'bye|bye bye|goodbye|good bye|ok bye|tata|see you|see you later|talk later|talk to you later',
  "that's all|that is all|nothing else|i have to go|i need to go|gotta go|hang up|i'll hang up",
  "that's it|i'm done|we're done|no more questions|have a nice day|have a good day|good night",
  'alvida|phone rakh|phone rakhta|rakhta hoon|rakhti hoon|rakhta hu|rakhti hu|baad mein baat',
  'बाय|अलविदा|फोन रख|रखता हूँ|रखती हूँ|बाद में बात',
  'vaikiren|vechudren|poitu varen|poyittu varen|வைக்கிறேன்|போயிட்டு வரேன்|பை',
  'end the call|end this call|end call|cut the call|cut this call|cut call|close the call',
  'stop the call|drop the call|disconnect|disconnect the call|you can hang up',
  'call cut karo|call cut kar do|call band karo|call band kar do|phone band karo|phone kaat do',
  'कॉल काट दो|कॉल कट करो|कॉल बंद करो|फोन काट दो',
]
  .flatMap((group) => group.split('|'))
  .map((phrase) => normalizeForMatch(phrase).split(' '));

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
 * to it ends the call. English and Hindi agents have it; any other the model asks in its words.
 */
const ASK_TO_END: Readonly<Record<string, string>> = {
  en: 'Shall I end the call?',
  hi: 'क्या मैं कॉल खत्म कर दूँ?',
};

/** The line an agent speaking `language` asks before ending a call it was not clearly asked to. */
export function askToEndLine(language: string): string | undefined {
  return ASK_TO_END[baseLanguageOf(language)];
}

export const END_REFUSED = {
  unheard: 'the caller was not heard clearly',
  early: 'the conversation has only just started',
  unasked: 'the caller has not clearly asked to end the call',
} as const;

/**
 * A yes to the agent's question, however it goes on ("Yes.", "Haan ji, end it."): the model still
 * decides whether to end the call; this only lets it.
 */
function saysYes(text: string): boolean {
  if (classifyConfirmation(text) === 'no') return false;
  const first = normalizeForMatch(text).split(' ')[0] ?? '';
  return affirmationOnly(text) || affirmationOnly(first);
}

/** True when the caller says goodbye ("ok bye", "phone rakhta hoon") or asks to end the call. */
export function saysGoodbye(text: string): boolean {
  const words = normalizeForMatch(text).split(' ').filter(Boolean);
  return GOODBYES.some((phrase) =>
    words.some((_, start) => phrase.every((word, offset) => words[start + offset] === word)),
  );
}

/**
 * N1: whether the LLM may end the call on this turn. A model that hangs up on a misheard first
 * turn, or on a caller still finding their words, loses the call, so `end_call` waits for
 * `minCallerTurns` turns and `minCallSeconds`, unless the caller says goodbye; and it never acts
 * on words that are untrusted: flagged by `UNTRUSTED_INPUT_VARIABLE`, or mostly in a script the
 * agent's language does not use (Russian heard on a Hinglish call). Untrusted turns do not count.
 * Wave 8b: past the minimums it still ends only on a clear goodbye or ask to end the call, or a
 * yes to the agent's own `askToEndLine` (call e8a43f65 hung up on "Ma'am, create a call.").
 */
export class EndCallGate {
  private callerTurns = 0;
  /** The words of the last turn counted. */
  private last = '';
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
    if (variables[UNTRUSTED_INPUT_VARIABLE] === true || foreignScript(input, this.scripts))
      return END_REFUSED.unheard;
    // AGT-10: a reply the caller spoke over before hearing any of it is run again on both
    // utterances together, which carry on the words already counted: still one caller turn. (Words
    // said again in a turn of their own count once too; the gate only ever waits longer for it.)
    const words = normalizeForMatch(input);
    if (!this.last || (words !== this.last && !words.startsWith(`${this.last} `)))
      this.callerTurns += 1;
    this.last = words;
    if (saysGoodbye(input) || (this.askedToEnd(previous) && saysYes(input))) return undefined;
    const ending = this.config.ending;
    const turns = ending?.minCallerTurns ?? DEFAULT_END_CALL_MIN_CALLER_TURNS;
    const seconds = ending?.minCallSeconds ?? DEFAULT_END_CALL_MIN_CALL_SECONDS;
    if (this.callerTurns < turns || this.now() - this.startedAt < seconds * 1000)
      return END_REFUSED.early;
    return END_REFUSED.unasked;
  }

  /** The agent's last line asked whether to end the call. */
  private askedToEnd(previous: readonly string[]): boolean {
    const asked = askToEndLine(this.config.language);
    const last = previous.at(-1);
    return Boolean(asked && last && normalizeForMatch(last) === normalizeForMatch(asked));
  }
}
