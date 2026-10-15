import { describe, expect, it } from 'vitest';
import type { Behavior, TextFilter } from '@winsendotai/ovo-contracts';
import { StreamingTextSegmenter } from '../../behaviors/src/text-segmenter.ts';
import { speakReply } from '../src/engine/turn-reply.ts';
import { splitsSpeechUnit } from '../src/engine/speech-units.ts';
import {
  createSpeechNormaliserFilter,
  filterSpeechText,
  indianVerbalisationFilter,
  markdownFilter,
  normaliseSpeechText,
  plugins,
  SPEECH_NORMALISER_FILTER_ID,
  urlFilter,
} from '../src/index.ts';

/**
 * Wave 9 D1: Maya call 10d5ef30 (2026-10-12 15:54–16:00 UTC, en-IN). The lines are the call's
 * `speech.generated` segments exactly as the LLM wrote them and the segmenter cut them; the TTS
 * read each one as written. Before Wave 9 the speaker's filters (markdown, URL, Indian
 * verbalisation) left every one of these unchanged. Wave 12 (call 8cb76efc F5): a semicolon
 * between clauses is said as the end of a sentence.
 */
const CALL_DAY = Date.parse('2026-10-12T15:55:00Z');
const SAID: readonly [segment: string, written: string, heard: string][] = [
  [
    'speech-8 (turn-3)',
    'Vienna and Prague are lovely choices: Vienna’s Rathausplatz market runs November 13 to December 26, 2026, and Prague’s Old Town market is expected to continue into early January.',
    'Vienna and Prague are lovely choices: Vienna’s Rathausplatz market runs the 13th of November to the 26th of December, and Prague’s Old Town market is expected to continue into early January.',
  ],
  [
    'speech-9 (turn-3)',
    'Are you planning to travel in December 2026 or January 2027?',
    'Are you planning to travel in December or January?',
  ],
  ['speech-11 (turn-5)', 'For December 26, 2026,', 'For the 26th of December,'],
  [
    'speech-12 (turn-5)',
    'I’m seeing Mumbai–Prague return fares around sixty-five thousand rupees for travel through January 10; exact prices depend on your departure city and return date, and fares can change quickly.',
    'I’m seeing Mumbai to Prague return fares around sixty-five thousand rupees for travel through the 10th of January. Exact prices depend on your departure city and return date, and fares can change quickly.',
  ],
  [
    'speech-16 (turn-8)',
    'December 21, 2026–January 5, 2027, I can’t confirm an exact fare for those dates, but a rough budget of seventy thousand rupees–one lakh rupees per person return is sensible for peak-season travel; prices vary by airline, stops, and baggage.',
    'the 21st of December to the 5th of January, I can’t confirm an exact fare for those dates, but a rough budget of between seventy thousand and one lakh rupees per person return is sensible for peak-season travel. Prices vary by airline, stops, and baggage.',
  ],
  [
    'speech-20 (turn-9)',
    'its Advent festival is scheduled for November 28, 2026, through January 7, 2027, so it’ll be running during your trip.',
    'its Advent festival is scheduled for the 28th of November to the 7th of January, so it’ll be running during your trip.',
  ],
  [
    'speech-45 (turn-18)',
    'Tromsø is a realistic add-on from Vienna, with a seasonal nonstop flight expected to begin November 28, 2026; otherwise, you can connect through Oslo.',
    'Tromsø is a realistic add-on from Vienna, with a seasonal nonstop flight expected to begin the 28th of November. Otherwise, you can connect through Oslo.',
  ],
];
/** Lines of the call the normaliser must leave as they are. */
const UNCHANGED = [
  'For Chennai to Prague,',
  'Sorry—I should’ve answered that directly:',
  'Sure—I can draft it,',
  'You’re right—you already said that.',
  'Sorry, I didn’t catch what you’d like—',
  'Would you like to fly into Prague, or start in Vienna for the Christmas markets?',
];

const WAVE8_FILTERS: TextFilter[] = [markdownFilter, urlFilter, indianVerbalisationFilter];
const normaliser = createSpeechNormaliserFilter({ now: () => CALL_DAY });
const FILTERS = [...WAVE8_FILTERS, normaliser];
const spoken = (text: string, filters = FILTERS, language = 'en-IN') =>
  filterSpeechText(filters, text, language);

/** What a listener should never hear read out: a dash in a range, this year or next, "December 21". */
function writtenForTheEye(text: string): string[] {
  return [
    ...(text.match(/[\d\p{L}]\s*[–—]\s*[\d\p{Lu}]/gu) ?? []),
    ...(text.match(/\b202[67]\b/g) ?? []),
    ...(text.match(/\b(?:January|November|December) \d/g) ?? []),
  ];
}

describe('call 10d5ef30 D1: what the TTS was given', () => {
  it.each(SAID)('%s reproduces with the Wave 8 filters', (_segment, written) => {
    expect(spoken(written, WAVE8_FILTERS)).toBe(written);
    expect(writtenForTheEye(spoken(written, WAVE8_FILTERS))).not.toEqual([]);
  });

  it.each(SAID)('%s is written for the ear', (_segment, written, heard) => {
    expect(spoken(written)).toBe(heard);
    expect(writtenForTheEye(heard)).toEqual([]);
    // Idempotent: a joined line, or a second pass, changes nothing.
    expect(spoken(heard)).toBe(heard);
  });

  it.each(UNCHANGED)('leaves %s as it is', (line) => {
    expect(spoken(line)).toBe(line);
  });

  it('is in the first-party inventory, between the URL (20) and Indian (30) filters', () => {
    expect(plugins.map((plugin) => plugin.manifest.id)).toContain(SPEECH_NORMALISER_FILTER_ID);
    expect(normaliser.order).toBeGreaterThan(urlFilter.order);
    expect(normaliser.order).toBeLessThan(indianVerbalisationFilter.order);
  });
});

/** Turn 8's reply, streamed in small deltas through the reply segmenter and the engine's speakReply. */
async function speakStreamed(reply: string): Promise<string[]> {
  const segmenter = new StreamingTextSegmenter(undefined, undefined, { language: 'en-IN' });
  const segments: string[] = [];
  for (let at = 0; at < reply.length; at += 4)
    segments.push(...segmenter.push(reply.slice(at, at + 4)));
  segments.push(...segmenter.finish());
  const behavior = {
    async *respondStream() {
      yield* segments;
    },
  } as unknown as Behavior;
  const said: string[] = [];
  await speakReply({
    behavior,
    text: 'And fly back in on January 5th, please.',
    variables: {},
    signal: new AbortController().signal,
    current: () => true,
    first: () => undefined,
    say: (line) => said.push(spoken(line)),
  });
  return said;
}

describe('call 10d5ef30 D1: streaming never splits a date or an amount', () => {
  it('turn 8 as the call segmented it, each line normalised whole', async () => {
    const reply =
      'For Chennai to Prague, December 21, 2026–January 5, 2027, I can’t confirm an exact fare for those dates, but a rough budget of seventy thousand rupees–one lakh rupees per person return is sensible for peak-season travel; prices vary by airline, stops, and baggage. Would you like to fly into Prague, or start in Vienna for the Christmas markets?';
    // The middle sentence is 241 characters: the segmenter's 240-character cap cuts it before
    // "baggage.", a cut that splits nothing the caller hears as one.
    expect(await speakStreamed(reply)).toEqual([
      'For Chennai to Prague,',
      SAID[4]![2].replace(/ baggage\.$/, ''),
      'baggage.',
      'Would you like to fly into Prague, or start in Vienna for the Christmas markets?',
    ]);
  });

  it('a first segment the segmenter ends at an em dash inside an amount range waits for the rest', async () => {
    // The segmenter ends a reply's first segment at "—" once it holds three words.
    const reply =
      'A rough budget is seventy thousand rupees—one lakh rupees per person, depending on dates. Shall I look at flights?';
    const segmenter = new StreamingTextSegmenter(undefined, undefined, { language: 'en-IN' });
    expect([...segmenter.push(reply), ...segmenter.finish()][0]).toBe(
      'A rough budget is seventy thousand rupees—',
    );
    expect(await speakStreamed(reply)).toEqual([
      'A rough budget is between seventy thousand and one lakh rupees per person, depending on dates.',
      'Shall I look at flights?',
    ]);
  });

  it('holds only a line that ends inside a range or a date', () => {
    expect(splitsSpeechUnit('A rough budget is seventy thousand rupees—')).toBe(true);
    expect(splitsSpeechUnit('Fares run from ₹70,000 –')).toBe(true);
    const long = 'The Christmas market in the Old Town square, with its stalls, lights and choir, ';
    expect(splitsSpeechUnit(`${long}${long}and the market closes on December`)).toBe(true);
    expect(splitsSpeechUnit(`${long}${long}and the market closes on December 21,`)).toBe(true);
    // A clause dash after words, a bare month and an ordinary end are spoken at once.
    expect(splitsSpeechUnit('Sorry, I didn’t catch what you’d like—')).toBe(false);
    expect(splitsSpeechUnit('Which one—')).toBe(false);
    expect(splitsSpeechUnit('Christmas markets run through December')).toBe(false);
    expect(splitsSpeechUnit('For the 26th of December,')).toBe(false);
  });

  it('a sentence over the segment cap cut inside a date is said whole', async () => {
    const reply =
      'Yes, it is. Prague’s Old Town market, with its wooden stalls, mulled wine, choirs and the big tree in front of the Týn Church, which is beautifully lit every evening at dusk for the crowds on the square, is expected to run from November 29, 2026–January 6, 2027, so you can catch it.';
    const segmenter = new StreamingTextSegmenter(undefined, undefined, { language: 'en-IN' });
    // The 240-character cap cuts the second sentence after "November 29,".
    expect([...segmenter.push(reply), ...segmenter.finish()][1]).toMatch(/November 29,$/);
    expect(await speakStreamed(reply)).toEqual([
      'Yes, it is.',
      'Prague’s Old Town market, with its wooden stalls, mulled wine, choirs and the big tree in front of the Týn Church, which is beautifully lit every evening at dusk for the crowds on the square, is expected to run from the 29th of November to the 6th of January, so you can catch it.',
    ]);
  });

  it('a held line is still said when the reply ends on it', async () => {
    expect(await speakStreamed('It is about ₹70,000—')).toEqual([
      'It is about seventy thousand rupees—',
    ]);
  });
});

describe('the speech normaliser', () => {
  const say = (text: string, language = 'en-IN') =>
    normaliseSpeechText(text, language, { now: () => CALL_DAY });

  it('drops only the year a caller would assume', () => {
    expect(say('In September 2026, December 2026, January 2027 and August 2027.')).toBe(
      'In September, December, January and August.',
    );
    // Last March, or a year and more away, keeps its year.
    expect(say('Since March 2026, until October 2027.')).toBe(
      'Since March 2026, until October 2027.',
    );
    expect(say('Book by 5 January 2028.')).toBe('Book by the 5th of January 2028.');
  });

  it('says dates day first in English other than en-US', () => {
    expect(say('On 2026-12-21, 21/12/2026, Dec. 21 and 21–24 December.')).toBe(
      'On the 21st of December, the 21st of December, the 21st of December and the 21st to the 24th of December.',
    );
    expect(say('The March 15, 2027 deadline.')).toBe('The 15th of March deadline.');
    expect(say('December 21, 2026–January 5, 2027 and November 28–30, 2026.', 'en-US')).toBe(
      'December 21st to January 5th and November 28th to 30th.',
    );
  });

  it('turns range dashes into words and symbols into words', () => {
    expect(say('From ₹500–₹700, 20–25% off, 5–7 days, 10am–2pm, Monday–Friday.')).toBe(
      'From ₹500 to ₹700, 20 to 25 percent off, 5 to 7 days, 10am to 2pm, Monday to Friday.',
    );
    expect(say('Around €80–120/night, 12°C & dry, ~3 hours, 5+ stops.')).toBe(
      'Around 80 euros to 120 euros per night, 12 degrees Celsius and dry, about 3 hours, 5 plus stops.',
    );
    expect(say('Vienna – the capital – is lovely.')).toBe('Vienna, the capital, is lovely.');
  });

  it('says a spaced en dash between two names as a pause, not "to" (review)', () => {
    // An opener, a spaced en dash, then a capitalised word: the caller hears a comma.
    expect(say('Absolutely – Vienna is lovely in December.')).toBe(
      'Absolutely, Vienna is lovely in December.',
    );
    expect(say('Yes – Monday works.')).toBe('Yes, Monday works.');
    expect(say('Mumbai – Delhi – Goa.')).toBe('Mumbai, Delhi, Goa.');
    // The call's unspaced pair is still a range.
    expect(say('Mumbai–Prague and Monday–Friday.')).toBe('Mumbai to Prague and Monday to Friday.');
  });

  it('keeps a date written "the 21st of December" day first in en-US too (review)', () => {
    expect(say('The 21st of December 2026 works.', 'en-US')).toBe('The 21st of December works.');
    expect(say('Fly on the 21st of December 2026.', 'en-US')).toBe('Fly on the 21st of December.');
    expect(say('December 21, 2026 works.', 'en-US')).toBe('December 21st works.');
  });

  it('leaves what is not a range alone', () => {
    for (const text of [
      'Call 98450-12345 or 1800-123-4567.',
      'It costs sixty-five thousand rupees.',
      'COVID-19 rules at gate A-12.',
      'It may 5 times.',
      'Sure—I can draft it.',
      'Which one—Prague or Vienna?',
    ])
      expect(say(text)).toBe(text);
    // Hindi and other languages are untouched.
    expect(say('December 21, 2026–January 5, 2027', 'hi-IN')).toBe(
      'December 21, 2026–January 5, 2027',
    );
  });
});
