import type { RuleLexicon } from '@winsendotai/ovo-contracts';

/*
 * Whole-utterance lexicons for the rules tier, matched on `normalizeUtterance` output. Ported from
 * the POC (poc/lib/flow.js YES/NO/SPEAKING and GLOBAL_INTENTS.repeat), which resolved most short
 * replies on Indian collections calls in 0ms, and extended with thanks/bye/wait in the same style.
 * English, Hindi and Tamil, in native script and romanised. Deliberately narrow: "yes but not now"
 * is not a yes, and goes to the decision model.
 */

const YES =
  /^(yes|yeah|yep|yup|ya|haan|han|ha|haan ji|ji|ji haan|haa|sure|correct|right|ok|okay|yes please|yes sure|हाँ|हां|हा|जी|जी हाँ|जी हां|हाँ जी|हां जी|aama|aamaa|aamam|amam|aamanga|sari|seri|saringa|ஆமா|ஆமாம்|ஆம்|ஆமாங்க|சரி|சரிங்க)( (ji|please|speaking|जी|ங்க|sir|madam))?$/u;
const NO =
  /^(no|nope|nahi|nahin|na|no thanks|no thank you|nothing|nothing else|thats all|thats it|no thats all|no thats it|nahi ji|no ji|नहीं|नही|ना|नहीं जी|illa|illai|illainga|venam|vendam|podhum|pothum|இல்லை|இல்ல|இல்லைங்க|வேண்டாம்|வேணாம்|போதும்|நன்றி)$/u;
const SPEAKING =
  /^((yes|haan|haan ji|ji) )?(speaking|this is (he|she|him|her|me)|(he|she) speaking|thats me|its me|bol raha hoon|bol rahi hoon|naan dhaan|naan thaan|naan than|pesuren|நான் தான்|நான்தான்|பேசுறேன்|நான் தான் பேசுறேன்)$/u;
const THANKS =
  /^(ok |okay )?(thanks|thank you|thank you so much|thanks a lot|dhanyavaad|dhanyawad|shukriya|bahut shukriya|nandri|romba nandri|धन्यवाद|शुक्रिया|நன்றி|ரொம்ப நன்றி)( (ji|sir|madam|ங்க))?$/u;
const BYE =
  /^((ok|okay|thanks|thank you|chalo) )?(bye|bye bye|goodbye|good bye|alvida|बाय|अलविदा|பை|போயிட்டு வரேன்)( (ji|sir|madam))?$/u;
/**
 * A lone "what?", "sorry?" or "kya?" (and "enna", Tamil for what) is not here: on a noisy line it
 * is as often the start of a sentence the turn detector cut short, or the caller reacting to what
 * they heard, and replaying the agent's last turn over them made the 2026-10-07 calls worse (P6).
 * The decision model still hears them and can pick `repeat`.
 */
const REPEAT =
  /^(pardon|come again|repeat|repeat that|can you repeat|can you repeat that|say that again|kya bola|phir se|phir se boliye|dobara|enna sonneenga|marupadiyum|excuse me|फिर से|दोबारा|மறுபடியும்)$/u;
const WAIT =
  /^(wait|one minute|one second|hold on|just a minute|just a second|ek minute|ek second|ruko|ruk jao|oru nimisham|konjam iru|रुको|एक मिनट|இருங்க|ஒரு நிமிஷம்)( (please|ji))?$/u;

export const RULE_LEXICON_PATTERNS: Readonly<Record<RuleLexicon, RegExp>> = Object.freeze({
  yes: YES,
  no: NO,
  speaking: SPEAKING,
  thanks: THANKS,
  bye: BYE,
  repeat: REPEAT,
  wait: WAIT,
});

/**
 * Lowercase, punctuation dropped (letters, combining marks and digits kept, so Devanagari and Tamil
 * survive intact), whitespace collapsed. The same transform is applied to authored phrases.
 */
export function normalizeUtterance(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
