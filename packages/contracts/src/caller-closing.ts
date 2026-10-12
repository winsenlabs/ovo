import { seeksInformation } from './agent-unclear.ts';
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
 * Words that say the caller needs nothing more ("No, I'm good.", "Never mind.", "That's all.",
 * "Bas, itna hi."). Not "that's fine": with thanks it as often accepts what the agent proposed.
 */
const DONE = phrases(
  [
    "i'm good|i am good|we're good|we are good|i'm okay|i am okay|i'm ok|i'm fine|i am fine",
    "all good|all set|i'm all set|we're all set|never mind|nevermind|nothing else|nothing more",
    "that's it|that's all|that'll be all|that will be all",
    'bas|bas itna hi|itna hi|aur kuch nahi|kuch nahi|बस|और कुछ नहीं',
  ].join('|'),
);

/** True when the caller says goodbye ("ok bye", "phone rakhta hoon") or asks to end the call. */
export function saysGoodbye(text: string): boolean {
  return hasPhrase(text, GOODBYES);
}

/**
 * Wave 9 (D4): the caller closes the conversation with thanks and words that say they need nothing
 * more ("No, I'm good. Thank you.", "Never mind. Thank you."), asking for nothing else. As clear as
 * a goodbye: asked "Shall I end the call?" after it in call 10d5ef30, the caller only said yes.
 */
export function closesConversation(text: string): boolean {
  if (seeksInformation(text) || /[?？]/u.test(text)) return false;
  return hasPhrase(text, THANKS) && hasPhrase(text, DONE);
}
