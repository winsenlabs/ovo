export const DISTRIBUTION_DEFAULTS = Object.freeze({
  engine: '@winsendotai/ovo-plugin-voice-session-engine',
  turnDetector: '@winsendotai/ovo-turn-detector-default',
  // Preselected only for an STT that finalises on a host commit (Scribe with manual commit): the
  // energy VAD's local silence drives the 'commit' turn strategy (~250 ms after the caller stops).
  vad: '@winsendotai/ovo-vad-energy',
  // Indian verbalisation runs before speech cache keys are computed (TTS-6); it rewrites only
  // English text (INR amounts, phone numbers, and en-IN dates).
  textFilters: [
    '@winsendotai/ovo-text-filter-markdown',
    '@winsendotai/ovo-text-filter-indian-verbalisation',
  ],
});
