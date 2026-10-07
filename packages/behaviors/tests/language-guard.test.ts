import { describe, expect, it } from 'vitest';
import { CallLanguages } from '../src/language-guard.ts';

const EN_HI = { language: 'en-IN', languages: { allowed: ['en', 'hi'] } };
const LINE = 'Sorry, I can only speak English or Hindi. Could you say that again?';

describe('CallLanguages (N4/P9)', () => {
  it('is inert without a language policy', () => {
    const languages = new CallLanguages({ language: 'en-IN' });
    expect(languages.offLanguage('Нет, это всё.')).toBe(false);
    expect(languages.note).toBeUndefined();
    expect(languages.line).toBeUndefined();
    expect(languages.reply()).toBeUndefined();
  });

  it('flags the Russian final the live LLM hung up on (call b1fd8b51), and counts it', () => {
    const languages = new CallLanguages(EN_HI);
    expect(languages.offLanguage('Нет, это всё.')).toBe(true);
    expect(languages.offLanguage('Okay. याद नहीं।')).toBe(false);
    expect(languages.metrics.snapshot()).toMatchObject({ offTurns: 1 });
    expect(languages.line).toBe(LINE);
  });

  it('pins the reply language in the platform note, naming the languages callers may mix', () => {
    expect(new CallLanguages(EN_HI).note).toBe(
      'Always reply in English, the language of this call, whatever language the caller uses. ' +
        'Callers may mix in Hindi; understand it, but answer in English. ' +
        'Never reply in any other language.',
    );
    expect(new CallLanguages({ language: 'en-IN', languages: { allowed: ['en'] } }).note).toBe(
      'Always reply in English, the language of this call, whatever language the caller uses. ' +
        'Never reply in any other language.',
    );
  });

  it('replaces a reply that starts in another language with the line, and drops the rest', () => {
    const languages = new CallLanguages(EN_HI);
    const guard = languages.reply()!;
    // The live reply of call b1fd8b51, as the segmenter cut it.
    expect(guard.check('Хорошо, спасибо за звонок.')).toBe(LINE);
    expect(guard.check('Хорошей поездки и до свидания!')).toBeUndefined();
    expect(guard.check('Have a good trip!')).toBeUndefined();
    expect(guard.replaced).toBe(true);
    expect(languages.metrics.snapshot()).toEqual({
      offTurns: 0,
      replacedReplies: 1,
      droppedSegments: 2,
    });
  });

  it('drops, rather than replaces, a reply that drifts after it has said something', () => {
    const guard = new CallLanguages(EN_HI).reply()!;
    expect(guard.check('Zagreb is lovely in December.')).toBe('Zagreb is lovely in December.');
    expect(guard.check('Hoe lang blijf je? Ik weet het niet.')).toBeUndefined();
    expect(guard.replaced).toBe(true);
  });

  it('passes allowed sentences through the reply guardrail after it', () => {
    const seen: string[] = [];
    const guard = new CallLanguages(EN_HI).reply((segment) => {
      seen.push(segment);
      return segment === 'blocked' ? undefined : `${segment}!`;
    })!;
    expect(guard.check('आपका EMI कल है।')).toBe('आपका EMI कल है।!');
    expect(guard.check('blocked')).toBeUndefined();
    // The reply already said something, so the drift is dropped, never sent to the guardrail.
    expect(guard.check('Нет.')).toBeUndefined();
    expect(seen).toEqual(['आपका EMI कल है।', 'blocked']);
    expect(guard.replaced).toBe(true);
  });

  it('keeps a fresh state per reply', () => {
    const languages = new CallLanguages(EN_HI);
    languages.reply()!.check('Нет.');
    const next = languages.reply()!;
    expect(next.replaced).toBe(false);
    expect(next.check('Your EMI is due tomorrow.')).toBe('Your EMI is due tomorrow.');
  });

  it('uses an authored line, for an agent language that has no default', () => {
    const line = 'மன்னிக்கவும், தமிழ் அல்லது ஆங்கிலத்தில் மீண்டும் சொல்ல முடியுமா?';
    const languages = new CallLanguages({
      language: 'ta-IN',
      languages: { allowed: ['ta', 'en'], line },
    });
    expect(languages.line).toBe(line);
    expect(languages.offLanguage('मुझे नहीं पता')).toBe(true);
    expect(languages.note).toContain('Always reply in Tamil');
  });
});
