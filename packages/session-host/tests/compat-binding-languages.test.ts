import { describe, expect, it } from 'vitest';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';
import { MULAW, fixture, speech, withConfig } from './compat-support.ts';

/** The fixture's TTS lists en-IN only, so only the STT slot's verdict is under test here. */
const sttRejects = (input: CompatInput) =>
  validateSelections(input, 'live').some(
    (issue) => issue.code === 'language_unsupported' && issue.slot === 'stt',
  );

/** An STT whose manifest languages are its default model's, with a table per bound model. */
function hindiAgent(model?: string, via: 'snapshot' | 'bindings' = 'snapshot') {
  const input = withConfig(
    fixture({
      stt: {
        capabilities: {
          ...speech,
          languages: ['en', 'en-IN'],
          inputFormats: [MULAW],
          bindingLanguages: {
            field: 'model',
            default: 'english',
            by: { english: ['en'], pro: ['en', 'hi', 'ta'] },
          },
        },
      },
    }),
    { language: 'hi-IN' },
  );
  const stt = input.selections!.stt!;
  const config = model ? { model } : {};
  if (via === 'snapshot') stt.binding = { ...stt.binding!, config };
  else {
    delete stt.binding;
    input.bindings = { [stt.bindingId!]: { provider: 'stt', config } };
  }
  return input;
}

describe('language_unsupported reads the binding-aware language table (STT-9)', () => {
  it('publishes a hi-IN agent when the bound model transcribes Hindi', () => {
    expect(sttRejects(hindiAgent('pro'))).toBe(false);
  });

  it('reads the binding from the provider-binding map when the release has no snapshot', () => {
    expect(sttRejects(hindiAgent('pro', 'bindings'))).toBe(false);
    expect(sttRejects(hindiAgent('english', 'bindings'))).toBe(true);
  });

  it('rejects the agent when the bound model is English-only', () => {
    expect(sttRejects(hindiAgent('english'))).toBe(true);
  });

  it("uses the field's declared default when the binding does not set it", () => {
    expect(sttRejects(hindiAgent())).toBe(true);
  });

  it('rejects a language the bound model lacks even with a table', () => {
    const input = withConfig(hindiAgent('pro'), { language: 'fr-FR' });
    expect(sttRejects(input)).toBe(true);
  });

  it('still accepts an exact manifest language without consulting the binding', () => {
    const input = withConfig(hindiAgent('english'), { language: 'en-IN' });
    expect(sttRejects(input)).toBe(false);
  });
});
