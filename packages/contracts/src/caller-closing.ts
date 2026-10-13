import { baseLanguageOf } from './agent-language.ts';
import { acknowledgementOnly, confirmationOnly, seeksInformation } from './agent-unclear.ts';
import { normalizeForMatch } from './text.ts';

/*
 * How a caller ends the conversation, read without a model, so the end-call gate (behaviors) and
 * the turn detector agree on it (Wave 9, Maya call 10d5ef30, issues D4 and D6).
 */

/** Phrases written `|`-separated, each matched as whole words. */
function phrases(list: string): string[][] {
  return list.split('|').map((phrase) => normalizeForMatch(phrase).split(' '));
}

function hasPhrase(text: string, list: readonly string[][]): boolean {
  const words = normalizeForMatch(text).split(' ').filter(Boolean);
  return list.some((phrase) =>
    words.some((_, start) => phrase.every((word, offset) => words[start + offset] === word)),
  );
}

/**
 * What callers say to end a call themselves, as STT writes it: English, Hinglish and Hindi, then
 * Tamil; then (Wave 8b) asking the agent outright to end it. Matched as whole words anywhere in
 * the turn ("ok thank you bye", "Maya, cut the call").
 */
const GOODBYES = phrases(
  [
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
  ].join('|'),
);

/** Thanks, in English, Hinglish, Hindi and Tamil. */
const THANKS = phrases(
  'thanks|thank you|thankyou|thank u|thanks a lot|dhanyavad|dhanyavaad|shukriya|धन्यवाद|शुक्रिया|நன்றி',
);

/**
 * Words that say the caller needs nothing more ("Never mind.", "That's all.", "Bas, itna hi.").
 * Not "that's fine": with thanks it as often accepts what the agent proposed. They close only with
 * nothing else around them: "bas" and "kuch nahi" also open "bas ek sawal hai" ("just one
 * question") and end "mujhe kuch nahi samjha" ("I didn't understand anything").
 */
const DONE = phrases(
  [
    "we're good|we are good|all good|all set|i'm all set|we're all set|never mind|nevermind",
    "nothing else|nothing more|that's it|that's all|that'll be all|that will be all",
    'bas|bas itna hi|itna hi|aur kuch nahi|kuch nahi|बस|बस इतना ही|इतना ही|और कुछ नहीं|कुछ नहीं',
  ].join('|'),
);

/**
 * "I'm good" and its kind, a closing only after a no ("No, I'm good. Thank you."): on their own
 * they as often answer "How are you?" ("I'm fine, thank you.").
 */
const WELL = phrases("i'm good|i am good|i'm okay|i am okay|i'm ok|i am ok|i'm fine|i am fine");

/** The no that declines the agent's offer ("No, I'm good."). */
const NO = phrases('no|nope|nah|nahi|nahin|नहीं|இல்லை');

/**
 * Words that ride along with a closing and change nothing: a yes or an okay, a word of address,
 * and what thanks are said with ("No, no, I'm good. Thank you so much, sir.").
 */
const ALONG = phrases(
  [
    'ok|okay|oh|so|well|yeah|yes|haan|ji|sure|alright|really|very|much|so much|very much|again',
    'sir|madam|maam|ma am|bhai|boss|dear|friend|dude|bro|buddy|yaar|हाँ|जी',
  ].join('|'),
);

/** The phrase of `list` that `words` start with at `at`, longest first: its length, or 0. */
function phraseAt(words: readonly string[], at: number, list: readonly string[][]): number {
  let longest = 0;
  for (const phrase of list)
    if (phrase.length > longest && phrase.every((word, offset) => words[at + offset] === word))
      longest = phrase.length;
  return longest;
}

/** True when the caller says goodbye ("ok bye", "phone rakhta hoon") or asks to end the call. */
export function saysGoodbye(text: string): boolean {
  return hasPhrase(text, GOODBYES);
}

/**
 * Wave 9 (D4): the caller closes the conversation with thanks and words that say they need nothing
 * more ("No, I'm good. Thank you.", "Never mind. Thank you."), and nothing else: every word is
 * thanks, such words, a no, or a word that rides along with them. As clear as a goodbye: asked
 * "Shall I end the call?" after it in call 10d5ef30, the caller only said yes. Anything left over
 * ("Thank you. Mujhe kuch nahi samjha.", "Thank you, I'm okay with that plan, book it") is not.
 */
export function closesConversation(text: string): boolean {
  if (seeksInformation(text) || /[?？]/u.test(text)) return false;
  const said = readPhrases(text, [THANKS, DONE, WELL, NO, ALONG]);
  if (!said) return false;
  const has = (kind: number) => said.includes(kind);
  return has(0) && (has(1) || (has(2) && has(3)));
}

/**
 * Wave 10 (Maya call 4f1a919d, B3): putting off what the agent offered ("I'll take it later",
 * "maybe later", "not now", "baad mein"). A first-person "I'll … later" of up to four words in
 * between is one too ("I'll book it later", "we will do that later").
 */
const LATER = phrases(
  [
    'later|later on|maybe later|some other time|another time|not now|not right now|not today',
    "next time|i'll think about it|i will think about it|i'll let you know|i will let you know",
    "i'll get back to you|i will get back to you|let me think about it|i'll see|i will see",
    'baad mein|baad me|phir kabhi|dekh lunga|dekh lungi|dekh lenge|soch ke bataunga',
    'soch ke batati hoon|बाद में|फिर कभी|देख लूंगा|देख लूँगा|देख लूंगी',
  ].join('|'),
);
const FUTURE = phrases("i'll|i will|we'll|we will");

/** The "I'll … later" `words` start with at `at`: its length, or 0. */
function putOffAt(words: readonly string[], at: number): number {
  const subject = phraseAt(words, at, FUTURE);
  if (!subject) return 0;
  const last = Math.min(words.length, at + subject + 5);
  for (let end = at + subject + 1; end < last; end += 1)
    if (words[end] === 'later') return end + 1 - at;
  return 0;
}

/**
 * The kind of each phrase `text` is made of, in order, as the index of its list in `lists` (with
 * `extra` read as the index after them), or undefined when any word is in none of them. Phrases
 * never run across the STT's punctuation: "No. I'm good" is a no and "I'm good".
 */
function readPhrases(
  text: string,
  lists: readonly (readonly string[][])[],
  extra?: (words: readonly string[], at: number) => number,
): number[] | undefined {
  const said: number[] = [];
  for (const clause of text.split(/[.,!;:।…—–]+/u)) {
    const words = normalizeForMatch(clause).split(' ').filter(Boolean);
    for (let at = 0; at < words.length;) {
      const lengths = lists.map((list) => phraseAt(words, at, list));
      if (extra) lengths.push(extra(words, at));
      const [kind, matched] = lengths.reduce<[number, number]>(
        (best, length, index) => (length > best[1] ? [index, length] : best),
        [-1, 0],
      );
      if (!matched) return undefined;
      said.push(kind);
      at += matched;
    }
  }
  return said;
}

/**
 * Wave 10 (Maya call 4f1a919d, B3): the caller declines what the agent offered or asked, puts it
 * off and thanks them, and says nothing else: a no first, thanks last ("No, okay, I'll take it
 * later. Thank you so much.", "Nahi, baad mein. Thank you."). A closing when it answers the agent's
 * offer or question (`EndCallGate`); live, asked "Shall I end the call?" after it, the caller only
 * said yes. Not a bare "No thanks." (the caller may go on), nor thanks first ("Thank you, I'll book
 * it later. And hotels?"), nor anything that asks.
 */
export function declinesWithThanks(text: string): boolean {
  if (seeksInformation(text) || /[?？]/u.test(text)) return false;
  const said = readPhrases(text, [THANKS, DONE, WELL, NO, ALONG, LATER], putOffAt);
  // What rides along aside ("Okay, no, …", "…thank you so much"): a no first and thanks last.
  const core = said?.filter((kind) => kind !== 4);
  if (!core || core[0] !== 3 || core.at(-1) !== 0) return false;
  return core.some((kind) => kind === 5 || kind === 6);
}

/**
 * Wave 10 (Maya call 4f1a919d, L3): words whose reply is a few words with nothing to look up: an
 * acknowledgement, a yes or no, thanks, a confirmation, a goodbye or a closing. A filler line before
 * such a reply is cut as it starts (turns 8, 11 and 12 played "One moment." 0.1–0.9 s before
 * replies of four to eight words), so none is played for them.
 */
export function expectsShortReply(text: string): boolean {
  return acknowledgementOnly(text) || confirmationOnly(text) || endsConversation(text);
}

/**
 * The caller says goodbye or closes the conversation (`saysGoodbye`, `closesConversation`,
 * `declinesWithThanks`): what is said next is a goodbye, or the question whether to end the call.
 */
export function endsConversation(text: string): boolean {
  return saysGoodbye(text) || closesConversation(text) || declinesWithThanks(text);
}

/**
 * Wave 10 (Maya call 4f1a919d, L2): the lines around the agent's own question before it ends a
 * call it was not clearly asked to end: the question, the goodbye a yes gets when the model's own
 * goodbye is not to hand, and the line a no gets. Fixed, so each is a clip rendered with the
 * release. English and Hindi; any other agent asks and answers through the model.
 */
const ENDING_LINES: Readonly<Record<string, EndingLines>> = {
  en: {
    ask: 'Shall I end the call?',
    goodbye: 'Thank you for your time. Goodbye!',
    resume: 'Sure. What else can I help you with?',
  },
  hi: {
    ask: 'क्या मैं कॉल खत्म कर दूँ?',
    goodbye: 'आपके समय के लिए धन्यवाद। नमस्ते!',
    resume: 'ठीक है। बताइए, और क्या मदद करूँ?',
  },
};

export interface EndingLines {
  ask: string;
  goodbye: string;
  resume: string;
}

export function endingLines(language: string): EndingLines | undefined {
  return ENDING_LINES[baseLanguageOf(language)];
}

/** A yes, said alone or with thanks or a goodbye ("Yeah, yeah, please.", "Haan ji, end it."). */
const YES = phrases(
  [
    'yes|yeah|yep|yup|ya|sure|ok|okay|alright|all right|go ahead|please do|do it|end it|you can',
    'haan|haan ji|ji haan|theek hai|ठीक है|हाँ|हां|जी|हाँ जी|ஆமா|ஆமாம்|சரி',
  ].join('|'),
);
/** A no, said alone ("No.", "No, no, wait.", "Not yet.", "Nahi."). */
const NOT_YET = phrases(
  [
    'no|nope|nah|no no|not yet|not now|not right now|wait|hold on|one second|one sec|one minute',
    'nahi|nahin|abhi nahi|ruko|नहीं|अभी नहीं|रुको|இல்லை|வேண்டாம்',
  ].join('|'),
);
/** Words a yes or a no is said with that change neither. */
const ASIDE = phrases(
  'please|sir|madam|maam|ma am|ji|bhai|boss|dear|oh|um|uh|umm|hmm|actually|so|well|very|much',
);

/**
 * Wave 10 (L2): the caller's answer to the agent's "Shall I end the call?" when it is nothing but
 * a yes (with thanks or a goodbye) or nothing but a no: `yes` ends the call and `no` carries on,
 * each with a fixed line and no model. Anything more ("Yes, but first the hotels", "No, thank
 * you.") is the model's to read.
 */
export function answersEnding(text: string): 'yes' | 'no' | undefined {
  if (/[?？]/u.test(text)) return undefined;
  const yes = readPhrases(text, [YES, THANKS, GOODBYES, ASIDE]);
  if (yes?.some((kind) => kind === 0 || kind === 2)) return 'yes';
  const no = readPhrases(text, [NOT_YET, ASIDE]);
  return no?.includes(0) ? 'no' : undefined;
}
