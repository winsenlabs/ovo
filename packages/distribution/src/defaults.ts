export const DISTRIBUTION_DEFAULTS = Object.freeze({
  engine: '@winsendotai/ovo-plugin-voice-session-engine',
  turnDetector: '@winsendotai/ovo-turn-detector-default',
  // Indian verbalisation runs before speech cache keys are computed (TTS-6); it rewrites only
  // English text (INR amounts, phone numbers, and en-IN dates).
  textFilters: [
    '@winsendotai/ovo-text-filter-markdown',
    '@winsendotai/ovo-text-filter-indian-verbalisation',
  ],
});
