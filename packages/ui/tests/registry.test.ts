import { describe, expect, it } from 'vitest';
import {
  ConsoleExtensionRegistry,
  coreConsoleExtensions,
  loadConsoleExtensions,
} from '../src/index.ts';

describe('console extension composition', () => {
  it('registers core forms through Cordis plugin composition', async () => {
    const extensions = await loadConsoleExtensions();
    expect(extensions.map((extension) => extension.id)).toEqual(
      coreConsoleExtensions.map((extension) => extension.id),
    );
    expect(
      extensions
        .flatMap((extension) => extension.forms)
        .some((form) => form.modes.includes('announcement')),
    ).toBe(true);
    expect(
      extensions.flatMap((extension) => extension.forms).some((form) => form.modes.includes('faq')),
    ).toBe(true);
    expect(
      extensions
        .flatMap((extension) => extension.forms)
        .some((form) => form.modes.includes('context')),
    ).toBe(true);
    expect(
      extensions
        .flatMap((extension) => extension.forms)
        .some((form) => form.modes.includes('agent')),
    ).toBe(true);
  });

  it('rejects duplicate extension ownership', () => {
    const registry = new ConsoleExtensionRegistry();
    registry.register(coreConsoleExtensions[0]!);
    expect(() => registry.register(coreConsoleExtensions[0]!)).toThrow(
      'Duplicate console extension',
    );
  });
});
