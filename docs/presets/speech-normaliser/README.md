# Speech normaliser: replies written for the ear

The speech normaliser (`@winsendotai/ovo-text-filter-speech-normaliser`, in
`packages/plugin-voice/src/speech/speech-normaliser.ts` and `speech-ranges.ts`) rewrites English
reply text before it reaches the TTS. It was added in Wave 9 after Maya call 10d5ef30, where the
TTS read the model's text as written: "December 21, 2026–January 5, 2027" and "seventy thousand
rupees–one lakh rupees".

## Every agent gets it

The speaker adds the normaliser to the agent's text filters whether or not the agent selected it
(`speakerTextFilters`), so releases pinned before Wave 9 get it too. It runs at order 25: after
markdown (10) and URLs (20), before Indian verbalisation (30), which then speaks the rupee
amounts. Hindi, Tamil and every non-English language pass through unchanged.

A line the segmenter ended inside a range or a date (`…seventy thousand rupees—`, or a sentence
over the segment cap cut after "December") waits for the next line and is said with it
(`engine/speech-units.ts`). Only such lines wait, typically for one more streamed segment.

## What it changes

| Written                                | Said (en-IN, on 2026-10-12)                    |
| -------------------------------------- | ---------------------------------------------- |
| `December 21, 2026–January 5, 2027`    | the 21st of December to the 5th of January     |
| `November 28, 2026, through January 7` | the 28th of November to the 7th of January     |
| `December 2026 or January 2027`        | December or January                            |
| `21–24 December`, `2026-12-21`         | the 21st to the 24th of December, the 21st of… |
| `Mumbai–Prague`, `Monday–Friday`       | Mumbai to Prague, Monday to Friday             |
| `seventy thousand rupees–one lakh`     | between seventy thousand and one lakh rupees   |
| `₹70,000–₹1,00,000`, `20–25%`          | between … and …, 20 to 25 percent              |
| `€120/night`, `12°C & dry`, `~3 hours` | 120 euros per night, 12 degrees Celsius and…   |

- **Years:** a year is dropped when the date falls between last month and ten months ahead,
  because the caller assumes it. Any other year is kept, so "October 2027" never becomes this
  October.
- **Day first:** dates are said day first with an ordinal in every English except `en-US`, which
  keeps "December 21st to January 5th". An agent serving Indian callers should have
  `language: en-IN`.
- **Kept as written:** a date already written for the ear ("21st of December"), a clause dash
  after words ("Sure—I can draft it"), a hyphen in a number word, a phone number or a code
  ("98450-12345", "COVID-19", "A-12"), and "may" or "march" as verbs.
- The normaliser is deterministic for a given day and idempotent, so a joined line or a second
  pass changes nothing.

Fixed lines that are pre-rendered (greetings, fillers) are keyed on the filtered text. A fixed
line that the normaliser changes needs the pre-render to start from `speakerTextFilters` too, or
it is synthesised live instead of played from the clip.

## Provider options checked (2026-10-13)

- **ElevenLabs TTS `apply_text_normalization`:** "By default, normalization is disabled for
  Flash v2.5 to maintain the low latency. However, Enterprise customers can now enable text
  normalization for v2.5 models by setting the `apply_text_normalization` parameter to "on"."
  ElevenLabs' advice for low-latency agents is to "have your LLM normalize the text before passing
  it to the TTS model" (https://elevenlabs.io/docs/overview/models). It would also not turn a range
  dash into "to" or drop a year. Not used: the normaliser does this deterministically at no
  latency. The binding's `applyTextNormalization` field remains for Enterprise accounts.
- **ElevenLabs TTS `language_code`:** "Language code (ISO 639-1) used to enforce a language for the
  model and text normalization" (https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
  It fixes the language, not the date style. Not changed.
- **Scribe v2 realtime (STT):** the query parameters are `language_code`, `keyterms`,
  `no_verbatim`, `include_timestamps`, `entity_detection`, the VAD settings and
  `commit_strategy`. None formats dates or numbers
  (https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime). Keyterms
  bias words the model does not know, and month names and ordinals are not such words. Turn 7's
  "December 21st is?" is the caller's own trailing words, which keyterms would not change. There
  is no STT change for D1.
