import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_TRUST_DEFAULTS, transcriptDoubt, type TranscriptDoubt } from '../src/index.ts';

/**
 * Wave 8 replay: every caller turn of call 6e1a4e3a (Maya, 2026-10-08, a noisy cafe), with its
 * endpoint in ms, from GET /v1/calls/:id/turns. The turn data has no voiced span, so each turn is
 * modelled at 2.5 words a second, plus, for the turn whose endpoint took 9.4 s, the cafe noise
 * that held the VAD open that long.
 */
const CAFE_CALL: ReadonlyArray<readonly [string, number]> = [
  ['हाँ।', 1836],
  ['Yeah, yeah, hi, my friend.', 1020],
  ['Hello?', 1892],
  ["I'm planning to go to Zagreb in Croatia. What do you know about this place?", 1006],
  [
    'Okay. Wait, wait, wait. Tell me, tell me about Zagreb. Hello? Wait, wait, wait, wait, wait. Tell me about the Hamburg as well.',
    1017,
  ],
  ['Hmm, okay. So, tell me more about Nuremberg.', 1017],
  ['Who are the Nazis?', 985],
  ["Ma'am, they seem like nice people.", 1199],
  ['Hardik?', 9426],
  ['Hello, if madam...', 1707],
  ['Credit. Okay, so...', 1712],
  ['Wait. Hold on.', 511],
  ['Listen to me. Listen to me, please.', 987],
  ["I'm in a coffee shop.", 1048],
  ['No. Can you check for flights from Chennai to Frankfurt?', 1009],
  ['Sometime during Christmas.', 1014],
  ["Yeah. So we'd like to leave on the 20th and be back around the 1", 675],
  ['st.', 0],
  ['जानकार, जानकार। एक लाख...', 1350],
  ['Two checks, sir, yes. Those dates are correct.', 1],
  ['Yeah.', 1873],
  ['Oh, my God.', 1868],
  ['Okay. Thank you, Danny.', 1027],
];

/** Caller turns of two earlier CreditMantri calls (4e4d2228, 8cbac365), quiet lines. */
const EARLIER_CALLS: readonly string[] = [
  'Yes, this is him.',
  'Sir, you have my last mail, no?',
  "Sorry, my mail, my job, I'm not able to make it.",
  'No, second one.',
  "Ma'am, where are you calling from again, ma'am?",
  "Ma'am, what is the time now?",
  'मुझे नोट करिए, can you say the number again?',
  'Something went wrong.',
  'Ene, ene, ene. Y le voy a dar por ahí la enemigo, entonces lo que se gasta.',
  'Vamos a pasar a PISRENGO.',
  '¿Y la gente a mí lo ves en la...?',
  'Tamil, tamil. Do you know Tamil?',
  'Can you repeat the number?',
  'I asked you to repeat the number, not what you said.',
  'Number, please.',
  'What number should I call back at?',
  'I think the number you said was not...',
  'Uh, correct.',
  'Can you please give me the correct-',
  "I think you're confused.",
  'Um.',
  'I was planning to take a trip to Y',
  'You tell me, Nisha. Just-',
  'Yes.',
  'No, my wife and I are planning a trip.',
  'You.',
  'Yes, myself and I are planning a trip to Europe.',
  'Uh.',
  'We want to finance this trip.',
  'I want to have something nice for the nurse.',
  'Yeah.',
  'Tell me where to order food from.',
  'What are you sure about?',
  'How old are you, Ananya?',
  'Yes, sir. It takes a lot of time.',
  'It is not.',
  'हम्म, हम्म।',
  "Ma'am, what is this? I am so random. I am-- Hello, wait, listen to me, only then you will be--",
  "What is this? You're so random. You didn't even tell me what the product is.",
  "You're lucky. What's the product? You didn't go there and tell me for-",
  'One minute.',
  'धन्यवाद, स्वागत।',
  'Please.',
  'Tell me who you are.',
  'Okay. Why are you calling me? Wait, wait one minute.',
  'No, no, one minute.',
  'Take my questions continuously.',
  'Can you be patient?',
  'Ну, ну, а-а-а?',
  'А-а-а, Нанья, Нан ья, будь пешент, Анания.',
  "Анания, you're too fast for-",
  'I need to understand.',
  'Yeah, and just wait, uh, one minute.',
  'Ananya, please stop.',
  'Okay, so listen to me one by one.',
  'What is your name?',
  'Answer my questions one by-',
  'One by one you answer. Answer my questions one by one.',
  'Okay, stop.',
  'What is my name?',
  'What is my name?',
  'What? Okay, are you...',
  'I, I do have it.',
  "No, one minute. I'm not here.",
  'Ananya, why did you call me?',
  'Why did you call me?',
  'Yes.',
  'Do I need to identify myself?',
  'Do you-- do I need- How do you know I am Rahul Sharma?',
  'Yes.',
  'Go ahead.',
  'You should be saying.',
  'That I am calling you because your number is registered with CreditMantri. That is the way you should say.',
  "Okay, I know, ma'am.",
  'Do you know any- No, do you know anything about this DPP act?',
  "See, because I'm-",
  'Under the DPP Act.',
  'Can CreditMantri divulge my data to an AI agent?',
  'I have not signed the consent, no.',
  'Can you tell me Mrs. Goudi?',
  'Do you know who the prom- do you know the-',
  'Yes, Ananya. I-',
  'Promoter, sir. Promoter of CreditMantri is a...',
  'Ananya, promoter of CreditMantri is a personal friend.',
  'अरे, नहीं, one minute, Ananya. दो minute रुको।',
  "Don't get upset.",
  'Okay? Just listen to what I have to say, patiently. I know the promoters of CreditMantri.',
  'Okay, I know your boss.',
  'I will tell them to give me another one month to pay. I will ge- tell them to give me one month to pay my loan.',
  'So I will handle it directly there.',
  "You please put into your record that I've already paid.",
  'Okay. Wait. You- Right, saying customer...',
  "Yeah, but you're telling-",
  'I, I was-',
];

const SPEAKING_MS_PER_WORD = 400;
const spokenMs = (text: string, endpointMs: number) =>
  text.split(/\s+/).length * SPEAKING_MS_PER_WORD + (endpointMs > 3_000 ? endpointMs : 0);

describe('doubtful transcripts (Wave 8)', () => {
  it('flags the garbled turns of the cafe call and takes every other turn as heard', () => {
    const doubts = CAFE_CALL.flatMap(([text, endpointMs]) => {
      const doubt = transcriptDoubt({
        text,
        language: 'en-IN',
        spokenMs: spokenMs(text, endpointMs),
      });
      return doubt ? [[text, doubt] as const] : [];
    });
    expect(doubts).toEqual<(readonly [string, TranscriptDoubt])[]>([
      ['Hardik?', 'low-information'],
      ['Hello, if madam...', 'fragment'],
      ['Credit. Okay, so...', 'fragment'],
      ['जानकार, जानकार। एक लाख...', 'fragment'],
    ]);
  });

  it('takes the quiet calls as heard, but for one four-word fragment', () => {
    const doubted = EARLIER_CALLS.filter((text) => transcriptDoubt({ text, language: 'en-IN' }));
    expect(doubted).toEqual(['What? Okay, are you...']);
  });

  it('doubts words the STT itself doubted, and only below the threshold', () => {
    const { minConfidence } = TRANSCRIPT_TRUST_DEFAULTS;
    expect(transcriptDoubt({ text: 'Hardik?', language: 'en', confidence: 0.12 })).toBe(
      'low-confidence',
    );
    expect(
      transcriptDoubt({ text: 'Chennai.', language: 'en', confidence: minConfidence }),
    ).toBeUndefined();
    expect(transcriptDoubt({ text: 'Chennai.', language: 'en' })).toBeUndefined();
  });

  it('a trailing ellipsis on thinking words, or on a long turn, is not a fragment', () => {
    for (const text of ['Okay, so...', 'Yeah, so...', 'Haan, matlab...', 'Hmm...'])
      expect(transcriptDoubt({ text, language: 'en-IN' }), text).toBeUndefined();
    expect(
      transcriptDoubt({ text: 'Promoter, sir. Promoter of CreditMantri is a...', language: 'en' }),
    ).toBeUndefined();
  });

  it('a short reply after a short wait is never low-information', () => {
    expect(transcriptDoubt({ text: 'Yes.', language: 'en', spokenMs: 3_900 })).toBeUndefined();
    expect(transcriptDoubt({ text: 'Yes.', language: 'en', spokenMs: 4_000 })).toBe(
      'low-information',
    );
    expect(transcriptDoubt({ text: 'Yes, that is fine.', language: 'en', spokenMs: 8_000 })).toBe(
      undefined,
    );
  });
});
