import { z } from 'zod';
import { baseLanguageOf } from './agent-language.ts';

/*
 * What a caller's words carry, read without a model (Wave 8, Maya call 6e1a4e3a in a noisy café):
 * whether they ask for anything, only acknowledge ("Yeah.", "Oh, my God.", "Thank you."), say yes,
 * or are cut off. The LLM's web search is not offered to words that only acknowledge, and the
 * uncertainty line is never the answer to words too unclear to answer.
 */

const Line = z.string().trim().min(1).max(300);

/**
 * Said, in the agent's language, instead of the uncertainty line when the caller's words were
 * unclear, garbled or carried too little to answer ("हाँ।", "Hardik?", "Credit. Okay, so...").
 * Rotated so the same line is never said twice in a row. English and Hindi agents have defaults;
 * any other agent falls back to its `clarification`.
 */
export const AgentUnclear = z.object({ lines: z.array(Line).min(1).max(5) }).strict();
export type AgentUnclear = z.infer<typeof AgentUnclear>;

const DEFAULT_UNCLEAR_LINES: Readonly<Record<string, readonly string[]>> = {
  en: [
    'Sorry, could you say that again?',
    "Sorry, I still didn't catch that. Could you put it another way?",
  ],
  hi: [
    'माफ़ कीजिए, क्या आप फिर से बता सकते हैं?',
    'माफ़ कीजिए, अब भी साफ़ समझ नहीं आया। क्या आप दूसरे तरीके से बता सकते हैं?',
  ],
};

/** The lines an agent says to unclear words: authored, else its language's default, else `clarification`. */
export function agentUnclearLines(config: {
  language: string;
  clarification: string;
  unclear?: AgentUnclear | undefined;
}): readonly string[] {
  if (config.unclear) return config.unclear.lines;
  return DEFAULT_UNCLEAR_LINES[baseLanguageOf(config.language)] ?? [config.clarification];
}

const WORD = /[\p{L}\p{M}]+/gu;
/** A turn the STT cut off mid-word or mid-sentence ("tell me about-", "Credit. Okay, so..."). */
const CUT_OFF = /(?:-|–|—|…|\.\.\.)$/u;
const QUESTION_MARK = /[?？]/u;

/** A word list, written space-separated. */
function wordSet(list: string): ReadonlySet<string> {
  return new Set(list.split(' '));
}

/** "Yes" in English, Hinglish, Hindi and Tamil, with the words that ride along ("haan ji", "yes sir"). */
const YES = wordSet(
  'yes yeah yep yup ya yah sure ok okay correct right haan han ha haa ji theek thik aama ' +
    'aamaa aamam seri sari हाँ हां हा जी ठीक ஆமா ஆமாம் சரி',
);
/** Words that ride along with a yes or an acknowledgement and add nothing to it. */
const ADDRESS = wordSet(
  'sir madam maam bhai boss dear friend my please hai है so well and then just very much',
);
const NO = wordSet('no nope nah nahi nahin na illa illai नहीं नही ना இல்லை இல்ல');
/** Thanks and goodbyes: with one stray word ("Thank you, Danny") still nothing to look up. */
const THANKS = wordSet(
  'thanks thank you thankyou bye goodbye dhanyavad shukriya धन्यवाद शुक्रिया நன்றி',
);
/**
 * Backchannels, fillers, greetings, exclamations and asks to wait ("hmm", "hello", "oh my god",
 * "wait, hold on").
 */
const ACKNOWLEDGE = wordSet(
  'wait hold on listen minute moment second ruko rukiye रुको hmm hm mm mhm uh um huh oh ' +
    'ah aha wow whoa omg god gosh really great nice good cool fine alright perfect hey hi ' +
    'hello accha acha achha arre हम्म अच्छा हेलो अरे ம்ம் ஹலோ',
);
/**
 * Words that ask: question words, the verbs of a request, and the things callers ask to have
 * looked up ("Weather Zagreb", "flights to Rome on Friday"), in English, Hinglish, Hindi and Tamil.
 */
const ASKING = wordSet(
  'what whats where when which who whom whose why how tell check find search look show ' +
    'give recommend suggest explain compare know list kya kab kahan kaha kaise kitna kitni ' +
    'kitne kaun kyun kyon bata batao bataiye batana chahiye enna eppo enga epdi evlo sollu ' +
    'sollunga weather forecast temperature price prices cost fare fares news flight flights ' +
    'train trains ticket tickets hotel hotels visa schedule timings mausam keemat kimat ' +
    'kiraya मौसम कीमत किराया क्या कब कहाँ कहां कैसे कितना कितनी कितने कौन क्यों बताओ बताइए ' +
    'बताइये बताना चाहिए என்ன எப்போ எங்க எப்படி எவ்வளவு யார் சொல்லு சொல்லுங்க',
);
/** A first word that opens an English yes/no question when the STT heard a question mark. */
const QUESTION_OPENER = wordSet(
  'is are am can could do does did will would should shall may have has any',
);

/** The caller's words, lower-cased, with apostrophes dropped ("what's" is "whats"). */
export function callerWords(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').match(WORD) ?? [];
}

/** The STT cut the caller off mid-word or mid-sentence. */
export function cutOffWords(text: string): boolean {
  return CUT_OFF.test(text.trim());
}

/** Only a yes, with nothing that changes it ("Yes.", "Haan ji.", "हाँ।", "Yes sir, okay."). */
export function affirmationOnly(text: string): boolean {
  const words = callerWords(text);
  return words.some((word) => YES.has(word)) && words.every((w) => YES.has(w) || ADDRESS.has(w));
}

/**
 * Words that acknowledge and ask for nothing: yes, no, a backchannel, a greeting, an exclamation,
 * thanks or a goodbye ("Yeah.", "Oh, my God.", "Hmm, okay.", "Thank you, Danny."). False for no
 * words at all.
 */
export function acknowledgementOnly(text: string): boolean {
  const words = callerWords(text);
  if (!words.length) return false;
  const known = (word: string) =>
    YES.has(word) || NO.has(word) || ADDRESS.has(word) || THANKS.has(word) || ACKNOWLEDGE.has(word);
  const unknown = words.filter((word) => !known(word));
  return !unknown.length || (unknown.length === 1 && words.some((word) => THANKS.has(word)));
}

/**
 * The caller asks for something: a question word or a request verb ("tell me about Zagreb",
 * "kitna hai"), or a question mark on two or more words or after a yes/no opener ("Is it open?").
 * A lone word with a question mark ("Hardik?", "Hello?") is not enough.
 */
export function seeksInformation(text: string): boolean {
  const words = callerWords(text);
  if (words.some((word) => ASKING.has(word))) return true;
  if (!QUESTION_MARK.test(text)) return false;
  return (words.length >= 2 && !acknowledgementOnly(text)) || QUESTION_OPENER.has(words[0] ?? '');
}

/**
 * Words too unclear or too thin to answer: cut off, no words, only an acknowledgement, or a lone
 * word that asks nothing ("Credit. Okay, so...", "हाँ।", "Hardik?"). A statement of two or more
 * words is not ("And in Split.", "Restaurants near the Colosseum."): it may be a follow-up that
 * names no question word.
 */
export function lowInformation(text: string): boolean {
  if (cutOffWords(text)) return true;
  const words = callerWords(text);
  if (!words.length || acknowledgementOnly(text)) return true;
  return words.length === 1 && !seeksInformation(text);
}

/**
 * What the punctuation of the caller's words says beyond the words: a question mark and a cut-off.
 * Two transcripts with the same words that differ in these can be answered differently (the
 * search tool goes to "Is the museum open?" but not to "Is the museum open.").
 */
export function callerPunctuation(text: string): [question: boolean, cutOff: boolean] {
  return [QUESTION_MARK.test(text), cutOffWords(text)];
}
