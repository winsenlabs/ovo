import { describe, expect, it } from 'vitest';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';
import { MULAW, fixture, speech, withConfig } from './compat-support.ts';

const languageIssues = (input: CompatInput) =>
  validateSelections(input, 'live').filter((issue) => issue.code === 'language_unsupported');

/** An en-IN agent (the fixture's STT and TTS list en-IN only) with callers allowed `allowed`. */
function agent(allowed: string[], stt: Record<string, unknown> = {}) {
  return withConfig(
    fixture({ stt: { capabilities: { ...speech, inputFormats: [MULAW], ...stt } } }),
    { mode: 'agent', languages: { allowed } },
  );
}

describe('language_unsupported covers the languages callers may speak (N4)', () => {
  it('accepts allowed languages the STT lists, by base code', () => {
    expect(languageIssues(agent(['en'], { languages: ['en-IN', 'hi-IN'] }))).toEqual([]);
    expect(languageIssues(agent(['en', 'hi'], { languages: ['en-IN', 'hi-IN'] }))).toEqual([]);
  });

  it('rejects an allowed language the STT does not transcribe, naming the field', () => {
    const issues = languageIssues(agent(['en', 'hi', 'ta'], { languages: ['en-IN', 'hi-IN'] }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      slot: 'stt',
      pluginId: 'stt',
      field: 'languages.allowed',
      message: 'stt does not support ta, an allowed language',
    });
  });

  it("reads the bound model's language table, as for the agent language", () => {
    const table = {
      languages: ['en-IN'],
      bindingLanguages: { field: 'model', default: 'ok', by: { ok: ['en', 'hi', 'ta'] } },
    };
    expect(languageIssues(agent(['en', 'hi', 'ta'], table))).toEqual([]);
    const english = {
      ...table,
      bindingLanguages: { ...table.bindingLanguages, by: { ok: ['en'] } },
    };
    expect(languageIssues(agent(['en', 'hi'], english)).map((issue) => issue.message)).toEqual([
      'stt does not support hi, an allowed language',
    ]);
  });

  it('accepts any language for an STT that lists none or a wildcard', () => {
    expect(languageIssues(agent(['en', 'ta'], { languages: ['*'] }))).toEqual([]);
  });

  it('leaves the TTS alone: it only speaks the agent language', () => {
    const issues = languageIssues(agent(['en', 'ta'], { languages: ['en-IN', 'ta-IN'] }));
    expect(issues).toEqual([]);
  });
});
