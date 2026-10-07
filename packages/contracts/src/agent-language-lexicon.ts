/*
 * The evidence `languageVerdict` reads: which languages a script writes, letters only some Latin
 * alphabets use, and short function-word lists. A word in none of them is neutral (a name, a
 * number, a loanword) and never decides anything.
 *
 * The lists are deliberately short and unambiguous. A marker word must not also be English,
 * romanized Hindi or romanized Tamil, which is how Indian callers code-mix: "de" (Hindi "give"),
 * "la", "lo", "se", "me", "na", "ne", "ja", "dar", "vale", "oye", "mira", "yani" and "tamam" are left out for that
 * reason, and so are "sim", "pour" and "nou" ("no" misheard), which English callers say.
 */

/** Base codes per non-Latin script. A script shared by languages names all of them. */
export const SCRIPT_LANGUAGES: readonly (readonly [RegExp, readonly string[]])[] = [
  [/\p{Script=Devanagari}/u, ['hi', 'mr', 'ne', 'sa', 'kok', 'mai']],
  [/\p{Script=Bengali}/u, ['bn', 'as']],
  [/\p{Script=Tamil}/u, ['ta']],
  [/\p{Script=Telugu}/u, ['te']],
  [/\p{Script=Kannada}/u, ['kn']],
  [/\p{Script=Malayalam}/u, ['ml']],
  [/\p{Script=Gujarati}/u, ['gu']],
  [/\p{Script=Gurmukhi}/u, ['pa']],
  [/\p{Script=Oriya}/u, ['or']],
  [/\p{Script=Cyrillic}/u, ['ru', 'uk', 'bg', 'sr', 'mk', 'be', 'kk', 'ky', 'mn', 'tg']],
  [/\p{Script=Arabic}/u, ['ar', 'fa', 'ur', 'ps', 'sd', 'ku']],
  [/\p{Script=Hebrew}/u, ['he', 'yi']],
  [/\p{Script=Greek}/u, ['el']],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, ['ja']],
  [/\p{Script=Han}/u, ['zh', 'yue', 'ja']],
  [/\p{Script=Hangul}/u, ['ko']],
  [/\p{Script=Thai}/u, ['th']],
  [/\p{Script=Georgian}/u, ['ka']],
  [/\p{Script=Armenian}/u, ['hy']],
  [/\p{Script=Ethiopic}/u, ['am']],
  [/\p{Script=Sinhala}/u, ['si']],
  [/\p{Script=Myanmar}/u, ['my']],
  [/\p{Script=Khmer}/u, ['km']],
  [/\p{Script=Lao}/u, ['lo']],
];

/**
 * Latin letters that English and romanized Indian languages never use, so a word carrying one is
 * in that alphabet's language. Common accents (é, ü, í) are not here: loanwords carry them.
 */
export const LATIN_LETTERS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/[ıİğĞşŞ]/u, ['tr', 'az']],
  [/[ñÑ]/u, ['es']],
  [/[ßẞ]/u, ['de']],
  [/[øØåÅæÆ]/u, ['da', 'no', 'sv']],
  [/[łŁżŻźŹ]/u, ['pl']],
  [/[őŐűŰ]/u, ['hu']],
  [/[ăĂșȘțȚ]/u, ['ro']],
  [/[ãÃõÕ]/u, ['pt', 'vi']],
  [/[ěĚřŘůŮ]/u, ['cs']],
  [/[ơƠưƯđĐ]/u, ['vi']],
];

/** Inverted punctuation that only Spanish writes. */
export const SPANISH_MARKS = /[¿¡]/u;

/**
 * Function words, lower case. For an allowed language they are evidence the caller speaks it; for
 * any other, evidence they do not (two or more of them are needed, see `languageVerdict`).
 */
export const FUNCTION_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set(
    (
      'i you he she it we they me my your our his her their the an is are was were am be been ' +
      'do does did have has had not no yes and or but if so to of in on at for with from what ' +
      'why how when where who which this that these those there here can will would should ' +
      'could please okay ok sir madam maam thanks thank sorry hello hi just only about'
    ).split(' '),
  ),
  // Romanized Hindi, as Scribe writes Hinglish in Latin script.
  hi: new Set(
    (
      'haan han nahi nahin hai hain kya main mera meri mere aap aapka aapki theek thik accha ' +
      'acha achha kar karo karna karunga karenge ji bhai abhi kal paisa paise mat ho hoon hun ' +
      'raha rahi tha thi ko ka ki ke kyun kaise kab kahan woh vo yeh ye bolo boliye samjha'
    ).split(' '),
  ),
  // Romanized Tamil (Tanglish).
  ta: new Set(
    (
      'illa illai enna sari aama aamam naan nee neenga ungal unga venum vendam sollunga solren ' +
      'panna pannunga irukku iruku romba konjam inniki naalaiku'
    ).split(' '),
  ),
  es: new Set(
    (
      'que qué por para con pero muy está estoy estás sí gracias hola bueno usted tengo quiero ' +
      'puedo vamos voy entonces porque también donde dónde cuando cuándo eso esto esta una los ' +
      'las del el ahí aquí nada gente ves cómo señor pasar hacer hay estamos claro tiene'
    ).split(' '),
  ),
  nl: new Set(
    (
      'ik niet het een wat maar ook zijn geen jij wij mijn heb hebt weet andere kant hier dat ' +
      'zaak lieg'
    ).split(' '),
  ),
  de: new Set('ich nicht und ist das der ein eine auch aber wir bitte danke nein'.split(' ')),
  fr: new Set('je suis est les des une oui merci avec vous nous mais bonjour très'.split(' ')),
  pt: new Set('não obrigado obrigada você muito isso'.split(' ')),
  it: new Set('grazie sono questo perché buongiorno ciao'.split(' ')),
  tr: new Set('bir yok evet değil çok'.split(' ')),
};

/**
 * Romanized Indian languages: their words are evidence for them when allowed, and never against
 * the caller when not. Indian callers code-mix in Latin script, so "enna sir" is no drift.
 */
export const ROMANIZED: ReadonlySet<string> = new Set(['hi', 'ta']);

/** Languages heard as one when transcribed: a Hindi speaker may come back in Urdu script. */
export const SPOKEN_AS_ONE: Readonly<Record<string, readonly string[]>> = {
  hi: ['ur'],
  ur: ['hi'],
};
