import type { RouteLines } from '@winsendotai/ovo-contracts';

/**
 * The router's built-in lines, for a release that does not author its own (§7.5): the line before
 * the handoff and the last-resort goodbye. Only `en` and `hi` exist; publish validation makes any
 * other default language author both.
 */
export const BUILT_IN_LINES = Object.freeze({
  connecting: { en: 'Connecting you now.', hi: 'आपकी कॉल अभी जोड़ी जा रही है।' },
  end: {
    en: 'Sorry, I could not connect your call right now. Please call again later. Goodbye.',
    hi: 'माफ़ कीजिए, अभी आपकी कॉल नहीं जुड़ पाई। कृपया बाद में फिर से कॉल करें। धन्यवाद।',
  },
} satisfies Record<string, RouteLines>);

/** The line in the caller's language, else in the default language, else the first authored. */
export function pickLine(
  lines: RouteLines,
  language: string | undefined,
  defaultLanguage: string,
): string {
  return (
    (language !== undefined ? lines[language] : undefined) ??
    lines[defaultLanguage] ??
    lines.en ??
    Object.values(lines)[0] ??
    ''
  );
}
