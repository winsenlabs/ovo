export const DISTRIBUTION_DEFAULTS = Object.freeze({
  engine: '@winsendotai/ovo-plugin-voice-session-engine',
  turnDetector: '@winsendotai/ovo-turn-detector-default',
  // Preselected only for an STT that finalises on a host commit (Scribe with manual commit): the
  // energy VAD's local silence drives the 'commit' turn strategy (~250 ms after the caller stops).
  vad: '@winsendotai/ovo-vad-energy',
  // Wave 8: the phone-line clean-up for every agent that selects none. Its defaults engage the
  // high-pass and the hum notches only on a line that hums or rumbles, so a clean line or a cafe
  // reaches the STT untouched (docs/presets/audio-filter/README.md has the measurements).
  audioFilter: '@winsendotai/ovo-audio-filter-telephony',
  // Indian verbalisation runs before speech cache keys are computed (TTS-6); it rewrites only
  // English text (INR amounts, phone numbers, and en-IN dates).
  textFilters: [
    '@winsendotai/ovo-text-filter-markdown',
    '@winsendotai/ovo-text-filter-indian-verbalisation',
  ],
});
