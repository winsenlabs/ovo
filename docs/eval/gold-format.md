# GOLD transcript format

A gold file says what the caller actually said, utterance by utterance. The call-eval harness
(`packages/eval`) scores turn segmentation, missed replies, reply latency and STT accuracy against
it. It lives at `packages/eval/corpus/gold/<call>.json`, where `<call>` is the corpus name of the
call (`call7`, `call8`). The STT lane writes it from the caller audio. The parser is
`packages/eval/src/corpus/gold.ts`; it accepts the fields below and ignores others.

```json
{
  "call": "call8",
  "callId": "eb509d62-3e43-4cfd-aee0-eb0680cdef0e",
  "units": "ms",
  "offsetMs": 214,
  "utterances": [
    {
      "id": "u01",
      "startMs": 8890,
      "endMs": 11120,
      "text": "Hey Maya, what's your real name?",
      "language": "en",
      "confidence": "high"
    },
    {
      "id": "u05",
      "startMs": 29400,
      "endMs": 31900,
      "text": "haan theek hai, Tejas bol raha hoon",
      "devanagari": "हाँ ठीक है, तेजस बोल रहा हूँ",
      "language": "mixed",
      "thought": "t04",
      "confidence": "low",
      "needsFounderReview": true
    }
  ],
  "needsFounderReview": ["u05"]
}
```

| Field                     | Meaning                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startMs`, `endMs`        | The utterance's first and last voiced audio, in ms since the call's `session.started` (the event timeline). With `"units": "s"`, `start`/`end` in seconds. |
| `offsetMs`                | Call time = caller-track time + `offsetMs`, as the audio was aligned (also read from `alignment.offsetMs`). The audio replay uses it.                      |
| `text`                    | The words as said. English in Latin script; Hindi romanised. Required.                                                                                     |
| `devanagari`, `romanised` | Other renderings of the same words. WER and CER take the closest rendering.                                                                                |
| `accept`                  | Further equally correct transcripts (`4,210` / `four thousand two hundred ten`).                                                                           |
| `language`                | `en`, `hi` or `mixed`. Language misdetection is counted against it.                                                                                        |
| `thought`                 | Utterances of one thought share an id: the caller paused mid-sentence and went on. Turn segmentation is scored per thought. Default: the utterance id.     |
| `expectsReply`            | `false` for a backchannel ("mm", "haan" over the agent). Default `true`, or `false` when `backchannel` is `true`.                                          |
| `overAgent`               | Said while the agent was speaking.                                                                                                                         |
| `confidence`              | `high`/`medium`/`low` or 0–1. Low-confidence utterances are listed in the report.                                                                          |
| `needsFounderReview`      | Per utterance, or a list of ids at the top level.                                                                                                          |

Without a gold file the harness still runs: metrics that need it (split and merge rates, false
endpoints, endpoint latency, missed replies against what was said, WER and CER) are reported as
`null`, and the proxies that need no reference (turns started under 1 s after the previous one
ended, LLM requests per answered turn, replies thrown away unheard) are reported instead.
