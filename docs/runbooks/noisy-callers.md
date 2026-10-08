# Callers in noisy places

Live call 6e1a4e3a (Maya, 2026-10-08) was made from a noisy cafe. Scribe heard "Hardik?" after
9.4 s of noise, "Hello, if madam...", "Credit. Okay, so..." and a Hindi "जानकार, जानकार। एक
लाख...", and the agent answered each one as if the caller had said it. It also heard "Thank you,
Maya" as "Thank you, Danny". This page covers what now runs by default, what you set per agent, and
what to read after a call.

## On by default

| What                    | Where                                             | Effect                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone-line audio filter | `DISTRIBUTION_DEFAULTS.audioFilter`               | Added for every agent that selects no filter. Its high-pass and hum notches engage only once the line hums or rumbles. A clean line, a cafe or a crowd reaches the STT sample for sample, because always-on filtering costs words there. See [audio filter presets](../presets/audio-filter/README.md). |
| Word confidence         | Scribe binding `confidence` (default `true`)      | Each final carries `confidence`, from 0 to 1: the geometric mean of the commit's word probabilities.                                                                                                                                                                                                    |
| Doubtful turns          | `transcriptDoubt` in `@winsendotai/ovo-contracts` | The turn detector sets `untrusted` on `turn.stopped`. The engine passes it to the reply as `inputUntrusted: true` and `inputDoubt`. Such a turn never ends the call.                                                                                                                                    |

A turn is untrusted for one of three reasons:

- **`low-confidence`**: the turn's lowest final confidence is under 0.45.
- **`low-information`**: four seconds or more of speech produced fewer than one word every two
  seconds. This is "Hardik?" after the cafe held the VAD open.
- **`fragment`**: four words or fewer that trail off into an ellipsis and are more than thinking
  words. "Credit. Okay, so..." is a fragment. "Okay, so..." is not.

The replay test in `packages/contracts/tests/transcript-trust.test.ts` runs every caller turn of
call 6e1a4e3a through these rules. It flags exactly the four garbled turns. Across 94 turns from
two earlier calls on quiet lines, it flags one: "What? Okay, are you...".

### What it costs in latency

- **Audio filter:** nothing. It does not buffer and has no look-ahead. Fault detection costs about
  20 multiply-adds per sample until a fault is found.
- **Word confidence:** a final waits for the word-level message that Scribe sends after each
  commit, so each turn ends that much later. The gap has not been measured on a live call; read
  `stt_confidence_wait.waitMs`.
  - The wait is capped at 120 ms.
  - If two commits in a row get no word-level message, the session stops waiting
    (`stt_confidence_unavailable`). A provider that never sends it costs at most 240 ms per call.
  - To turn it off, set `voice.stt` binding `confidence: false`.

## Per agent

The agent's Scribe settings live in two places: `voice.stt.config` for the agent and the Scribe
binding for the provider connection.

| Setting                           | Where              | Example                       | Use                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentName`                       | `voice.stt.config` | `"Maya"`                      | Scribe favours it as a keyterm on every call, ahead of the agent's other keyterms.                                                                                                                                                                                     |
| `agentNameMishearings`            | `voice.stt.config` | `["Danny", "Mia"]`            | Puts the name back when the caller addresses the agent: "Thank you, Danny." becomes "Thank you, Maya." The word must follow thanks, a greeting or an acknowledgement and end its clause, so "Danny will pay" is left alone. Add the words you see in call transcripts. |
| `keyterms`, `keytermVariables`    | `voice.stt.config` | `["Zagreb"]`, `["full_name"]` | Words the calls are about, and the caller's own name (STT-11).                                                                                                                                                                                                         |
| `languageMode`, `sessionLanguage` | binding            | `"session"`, `"en"`           | Pins the language. Use this for an English-only agent such as Maya: in `auto` mode on 8 kHz audio, Scribe drifts into other languages.                                                                                                                                 |
| `secondaryLanguages`              | binding            | `["hi"]`                      | Hinglish callers of an en-IN agent such as CreditMantri. Sent as repeated `secondary_languages` parameters, as the official SDK does. Pair it with `languageDetection: true` for one live call, then read `stt_language_detected`.                                     |
| `filterBackgroundAudio`           | binding            | `true`                        | Scribe's own background-speech filter. **Off by default and unmeasured.** Try it for one live call on an agent whose callers ring from cafes or streets, and compare transcripts.                                                                                      |

These defaults depend on the agent, so the plugin does not set them:

- **Secondary Hindi:** the plugin cannot see an agent's allowed languages. A default secondary
  Hindi would write an English-only agent's callers' "haan" in Devanagari, and the off-language
  guard would then answer it with the language line.
- **Background filter:** what it does to a quiet caller's words with manual commit is unknown.

## After a live call

Read the worker logs (`service: stt-elevenlabs`) and the turn data:

1. **`stt_confidence_wait`**, one line per commit, gives the gap and the confidence.
   - The gap should be a few milliseconds. If `stt_confidence_unavailable` appears, the provider
     sent no word-level messages, and confidence is off for that call.
   - Compare the confidence values of clear and garbled turns. If 0.45 does not separate them,
     change `TRANSCRIPT_TRUST_DEFAULTS.minConfidence`. Its unit test pins the boundary.
2. **`stt_language_detected`** (with `languageDetection: true`) shows whether Hinglish turns stay
   en/hi.
3. Turns marked `untrusted` should be the garbled ones. The agent should ask the caller to say it
   again rather than search or decide on them; that reply is the behaviour's job.
4. If a line hummed, the audio filter engaged within about a second. Nothing is logged for this;
   compare the recording's inbound track.
