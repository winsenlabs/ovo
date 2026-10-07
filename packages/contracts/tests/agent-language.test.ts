import { describe, expect, it } from 'vitest';
import { AgentConfig, agentLanguageLine, languageVerdict, offLanguage } from '../src/index.ts';
import { FUNCTION_WORDS, ROMANIZED } from '../src/agent-language-lexicon.ts';

const EN_HI = ['en', 'hi'];

/**
 * Caller transcripts from the live calls of 2026-10-07: the Maya calls (b1fd8b51, bcbc7d6a,
 * 50ac3860) and the CreditMantri calls (A 4e4d2228, B 8cbac365), as Scribe returned them.
 */
const DRIFTED = [
  // b1fd8b51: the interim that barged in on the greeting, and the final the LLM hung up on.
  'Знаете, что?',
  'Нет, это всё.',
  // bcbc7d6a: Dutch drift.
  'Huh? Nee, ik wil de andere kant.',
  'Ah, oké. Dat is hier in de zaak.',
  // 50ac3860
  'Ik lieg niet.',
  // bcbc7d6a: Turkish drift.
  'Yarım yüz lira.',
  'Hıhı.',
  // Call A: Tamil transcribed as Spanish (P9).
  'Y le voy a dar por ahí la enemigo, entonces lo que se gasta.',
  'Vamos a pasar a PISRENGO.',
  '¿Y la gente a mí lo ves en la...?',
  // Call B
  'Ну, ну, а-а-а?',
];

const UNDERSTOOD = [
  "We're planning to go to Zagreb this time. Can you tell me more about it?",
  'Okay. याद नहीं।',
  'आप मुझे पकड़ कर गया हैं sir. इधर मैं बोल रहा हूँ',
  'मुझे नोट करिए, can you say the number again?',
  'अरे, नहीं, one minute, Ananya. दो minute रुको।',
  // Code-mixed Russian name in English words: the caller is speaking English.
  "Анания, you're too fast for-",
  // Misheard English the guard cannot and must not judge.
  'Nou, nou, Italy, English, English.',
  'Nee.',
  'Yok.',
  'Yani-',
  'Ene, ene, ene.',
  // Romanized Hinglish and Tanglish, as Scribe writes them.
  'haan main kal pay kar dunga',
  'theek hai sir, abhi nahi',
  'enna sir, illa sir, naan konjam late',
  'Per EMI.',
  'I am drunk.',
  '',
];

describe('languageVerdict (N4/P9)', () => {
  it.each(DRIFTED)('treats the drifted live transcript %j as off an en/hi agent', (text) => {
    expect(offLanguage(text, EN_HI)).toBe(true);
  });

  it.each(UNDERSTOOD)('keeps %j, which an en/hi agent understands', (text) => {
    expect(offLanguage(text, EN_HI)).toBe(false);
  });

  it('names the outside languages it saw', () => {
    expect(languageVerdict('Нет, это всё.', EN_HI).foreign).toContain('ru');
    expect(languageVerdict('Ik lieg niet.', EN_HI).foreign).toEqual(['nl']);
    expect(languageVerdict('Okay. याद नहीं।', EN_HI).foreign).toEqual([]);
  });

  it('follows the allowed set: Tamil script is off an en/hi agent and on an en/hi/ta one', () => {
    const tamil = 'இல்லையா? முடிச்சுட்டு போகணும';
    expect(offLanguage(tamil, EN_HI)).toBe(true);
    expect(offLanguage(tamil, ['en', 'hi', 'ta'])).toBe(false);
    // Mixed, mostly Tamil: off unless Tamil is allowed.
    const mixed = 'NACH, MOOC, புடிக்கிறது கிடையாது sir. இந்த மாதிரி க';
    expect(offLanguage(mixed, EN_HI)).toBe(true);
    expect(offLanguage(mixed, ['en', 'ta'])).toBe(false);
  });

  it('counts Devanagari as off an English-only agent', () => {
    expect(offLanguage('मुझे नहीं पता', ['en'])).toBe(true);
    expect(offLanguage('मुझे नोट करिए, can you say the number again?', ['en'])).toBe(false);
  });

  it('hears Hindi transcribed in Urdu script as Hindi', () => {
    expect(offLanguage('مجھے نہیں پتا', EN_HI)).toBe(false);
    expect(offLanguage('مجھے نہیں پتا', ['en'])).toBe(true);
  });

  it('needs more than one Latin function word, and more outside words than inside', () => {
    expect(offLanguage('Gracias!', ['en'])).toBe(false);
    expect(offLanguage('Gracias, muy bien.', ['en'])).toBe(true);
    expect(offLanguage('I said gracias to the man at the counter', ['en'])).toBe(false);
  });

  it('accepts an allowed Latin language', () => {
    expect(offLanguage('Vamos a pasar a PISRENGO.', ['en', 'es'])).toBe(false);
  });

  // Romanized Hindi words that other Latin languages also write: German "das" and "der", Dutch
  // "maar". A CreditMantri promise to pay is all amounts and dates, so it is full of them.
  const HINGLISH_HOMOGRAPHS = [
    'Das tarikh ko de dunga, thodi der lagegi',
    'Haan das das hazaar karke',
    'Der ho gayi, das din',
    'das din der',
    'Bas das minute der',
    'Das. Das.',
    'Das din der ho jayega',
    'maar maar ke',
  ];

  it.each(HINGLISH_HOMOGRAPHS)('keeps the Hinglish %j for an en/hi agent', (text) => {
    expect(languageVerdict(text, EN_HI)).toEqual({ off: false, foreign: [] });
  });

  it.each(HINGLISH_HOMOGRAPHS)('never counts the Hinglish %j against an English agent', (text) => {
    expect(offLanguage(text, ['en'])).toBe(false);
  });

  it('still hears German and Dutch without their Hindi homographs', () => {
    expect(languageVerdict('Ich weiß das nicht.', EN_HI).foreign).toEqual(['de']);
    expect(offLanguage('Nein, das ist nicht richtig.', EN_HI)).toBe(true);
    expect(offLanguage('Maar ik weet het niet.', EN_HI)).toBe(true);
  });

  it('lists no foreign marker that romanized Hindi or Tamil also writes', () => {
    const indic = [
      ...FUNCTION_WORDS.hi!,
      ...FUNCTION_WORDS.ta!,
      ...'de la lo se me na ne ja dar des para nada pada'.split(' '),
    ];
    const markers = Object.entries(FUNCTION_WORDS).filter(([code]) => !ROMANIZED.has(code));
    const clashes = markers.flatMap(([code, words]) =>
      indic.filter((word) => words.has(word) && code !== 'en').map((word) => `${code}:${word}`),
    );
    expect(clashes).toEqual([]);
  });

  it('checks the LLM replies of the live calls', () => {
    expect(offLanguage('Хорошо, спасибо за звонок. Хорошей поездки и до свидания!', EN_HI)).toBe(
      true,
    );
    expect(offLanguage('Zagreb is Croatia’s capital,', EN_HI)).toBe(false);
    expect(offLanguage('Plaza de España is lovely in December.', EN_HI)).toBe(false);
  });
});

const agent = (raw: Record<string, unknown>) =>
  AgentConfig.safeParse({ name: 'a', mode: 'agent', language: 'en-IN', ...raw });

describe('AgentConfig.languages', () => {
  it('accepts allowed base codes that include the agent language', () => {
    const parsed = agent({ languages: { allowed: ['en', 'hi'] } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.languages).toEqual({ allowed: ['en', 'hi'] });
  });

  it('is optional, and absent by default', () => {
    expect(agent({}).data?.languages).toBeUndefined();
  });

  it("rejects allowed languages that leave out the agent's own", () => {
    const parsed = agent({ languages: { allowed: ['hi', 'ta'] } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['languages', 'allowed']);
  });

  it('rejects full tags, duplicates, an empty list and unknown fields', () => {
    expect(agent({ languages: { allowed: ['en-IN'] } }).success).toBe(false);
    expect(agent({ languages: { allowed: ['en', 'en'] } }).success).toBe(false);
    expect(agent({ languages: { allowed: [] } }).success).toBe(false);
    expect(agent({ languages: { allowed: ['en'], reply: 'hi' } }).success).toBe(false);
  });

  it('requires agent mode', () => {
    const parsed = agent({ mode: 'context', languages: { allowed: ['en'] } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['languages']);
  });

  it('requires an authored line for an agent language without a default', () => {
    expect(agent({ language: 'ta-IN', languages: { allowed: ['ta', 'en'] } }).success).toBe(false);
    expect(
      agent({
        language: 'ta-IN',
        languages: { allowed: ['ta', 'en'], line: 'மன்னிக்கவும், மீண்டும் சொல்ல முடியுமா?' },
      }).success,
    ).toBe(true);
  });
});

describe('agentLanguageLine', () => {
  it('names the allowed languages, the agent language first', () => {
    expect(
      agentLanguageLine({ language: 'en-IN', languages: { allowed: ['hi', 'en', 'ta'] } }),
    ).toBe('Sorry, I can only understand English, Hindi or Tamil. Could you say that again?');
    expect(agentLanguageLine({ language: 'en-IN', languages: { allowed: ['en'] } })).toBe(
      'Sorry, I can only understand English. Could you say that again?',
    );
    expect(agentLanguageLine({ language: 'hi-IN', languages: { allowed: ['hi', 'en'] } })).toBe(
      'माफ़ कीजिए, क्या आप हिंदी या अंग्रेज़ी में दोबारा बता सकते हैं?',
    );
  });

  it('prefers the authored line, and is undefined without a policy', () => {
    expect(
      agentLanguageLine({ language: 'en-IN', languages: { allowed: ['en'], line: 'Pardon?' } }),
    ).toBe('Pardon?');
    expect(agentLanguageLine({ language: 'en-IN' })).toBeUndefined();
  });
});
