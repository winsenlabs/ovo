# Transcript-quality fixtures

`transcripts.json` holds what an offline ASR heard for every clip in `../phone-speech/` under every
condition in `../phone-noise.ts`, with the audio filter off and with each preset in
`docs/presets/audio-filter/`, plus the SHA-256 of the exact mu-law it heard.
`../../transcript-quality.test.ts` recomputes that audio and fails if any hash differs, so the
transcripts always describe the filter as it is.

To measure again (the test tells you when), see "Measuring again" in
`docs/presets/audio-filter/README.md`: `measure.ts` runs `vosk_asr.py` (Vosk 0.3.44,
`vosk-model-small-en-in-0.4`, from https://alphacephei.com/vosk/models, retrieved 2026-10-07).
