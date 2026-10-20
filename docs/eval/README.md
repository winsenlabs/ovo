# Call eval harness

`packages/eval` measures call quality so it is no longer judged by ear after each call. It
replays recorded calls through the production pipeline and scores what the caller would have
heard: how the caller's speech was cut into turns, whether each thought got an answer, how
long it took, what was composed and thrown away, how many LLM requests that cost, and how well
the STT heard the words. A scorecard against a committed baseline is a regression gate that
`scripts/mini-ci.sh` runs offline on every merge.

```bash
pnpm eval:calls                                   # transcript replay of packages/eval/corpus
pnpm eval:calls --mode live                       # score the calls as they happened
pnpm eval:calls --baseline packages/eval/baselines/transcript-rules.json   # the gate (exit 1)
pnpm eval:calls --detector module:packages/plugin-turn-detector-x/src/index.ts#createTurnDetector
pnpm eval:calls --detector-config '{"commit":{"silenceMs":450}}'
pnpm eval:calls --mode audio --stt scribe-en --keys ~/.ovo-eval/keys.env --corpus <raw dir>
pnpm eval:calls --transcripts packages/eval/out/<audio run>/transcripts      # replay another STT's words
pnpm eval:calls diff <baseline.json> <candidate.json>
pnpm eval:calls slim --from <raw dir> --to packages/eval/corpus
pnpm eval:calls stt-configs --keys ~/.ovo-eval/keys.env
```

Each run writes `<label>.json` (the scorecard), `<label>.md` and `<label>.html` to `--out`
(default `packages/eval/out/`, not committed). The HTML page is self-contained: headline
numbers, the before/after table with the gate's verdict, and per call a timeline (gold
utterances, the detector's turns, the agent's lines heard, cut or thrown away) and the turn and
utterance tables.

## The corpus

A corpus is a directory of calls, one file per kind, `<call>-<kind>`:

| File                   | What                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `<call>-events.jsonl`  | The control plane's event export (`/v1/calls/:id/events`). Required for any replay.                       |
| `<call>-turns.json(l)` | Per-turn summaries (`/v1/calls/:id/turns`). Used only when there are no events (call 4: live scoring).    |
| `<call>-caller.wav`    | The caller track (8 kHz mono). Audio replay needs it; transcript replay reads its VAD trace off it.       |
| `<call>-vad.json`      | A VAD trace: where the energy VAD heard speech, frame by frame, and the track's offset. `slim` writes it. |
| `<call>-manifest.json` | The recording manifest: the fallback for the track's offset.                                              |
| `gold/<call>.json`     | What the caller actually said ([gold-format.md](gold-format.md)). Optional.                               |
| `corpus.json`          | Optional labels, notes, per-call `audioOffsetMs` overrides and an agent profile.                          |

`packages/eval/corpus` holds the founder's Maya calls 4–8, slimmed: the events the harness
reads (about 100 KB a call) and, for calls 7 and 8, the VAD trace instead of the audio. A
raw corpus (the files as exported, with the WAVs) stays outside the repository; `slim` turns
it into a committable one, and a transcript replay of either gives the same scorecard.

**The caller track's offset.** The recordings API says its alignment is not waveform-
synchronized, and on calls 7 and 8 the manifest's start was about 1 s out. The loader reads the
offset off the audio instead: the one most of the call's `user.turn` starts agree on, each start
being the VAD's report 200 ms into speech (call 8: −829 ms from 23 of 30 turn starts). The gold
file's offset, which the STT lane stamps by speech onset, is only a fallback.

## Modes

| Mode         | STT                                         | VAD                                 | Turn detector, engine, behaviour | LLM                | Time      |
| ------------ | ------------------------------------------- | ----------------------------------- | -------------------------------- | ------------------ | --------- |
| `live`       | as recorded                                 | as recorded                         | as recorded                      | as recorded        | none      |
| `transcript` | the call's own transcripts, Scribe modelled | the VAD trace (`--vad audio`: real) | real                             | recorded responder | virtual   |
| `audio`      | a live plugin (`--stt`), keys from `--keys` | the real energy VAD on the track    | real                             | recorded (or live) | real time |

A replay is OVO's own `NativeVoiceSessionEngine` with its turn driver, scheduler and
`AgentBehavior` (speculation and all), the turn detector chosen, the agent's VAD row, behind
the conformance kit's fake carrier. Three parts are stand-ins:

- **Speech output.** Timed, not synthesised: first audio 200 ms after a line is played (2 ms for
  cached fillers and the opening), then the line's characters at the speaking rate measured on
  the live call (Maya: about 62 ms a character).
- **The LLM.** The recorded responder answers each request with what the model said live for
  those words (found by their overlap with each live turn, and the call's order; a merged
  request by its newest words), after the compose time the live request took, searching again
  (and announcing it) when the live turn searched. Platform lines (fillers, offers of more,
  canned replacements) are taken off first: the behaviour adds its own. `--llm-model` puts a live
  OpenAI model in instead (audio mode only, with `OPENAI_API_KEY` in the keys file or
  `OVO_EVAL_OPENAI_API_KEY` in the environment).
- **Scribe, in transcript mode.** Interims land when they landed live. Scribe finalises only on
  a commit, so a replayed commit is answered by the live final when the live call made the same
  commit (a final within 0.7 s after it, or one already in hand up to 120 ms before), and
  otherwise by the model: 320 ms later, with the words heard by then. The report counts how many
  commits the model answered (3–5 a call with the production detector).

**Open loop.** The caller says what they said live, when they said it, whatever the agent does
differently. A replay measures the pipeline's reaction to the same caller, not the
conversation that would have followed. The detector's idle prompts are off in replays for the
same reason.

**Determinism.** Transcript replays run on virtual time (the kit's `FakeClock` with the timer
globals and `Date.now` routed through it): the whole corpus replays in about 3 s, the same way
every time.

### How close a replay is to the live call

The production detector replayed over the corpus, against the calls as they happened
(live / replay):

| Metric                            | call 5  | call 6  | call 7    | call 8    |
| --------------------------------- | ------- | ------- | --------- | --------- |
| Caller turns answered             | 21 / 16 | 12 / 10 | 24 / 24   | 29 / 29   |
| LLM requests                      | 32 / 27 | 18 / 13 | 50 / 46   | 35 / 35   |
| Replies composed, none heard      | 3 / 0   | 0 / 0   | 4 / 7     | 10 / 12   |
| Turns with no audible reply       | 8 / 2   | 2 / 1   | 9 / 10    | 14 / 15   |
| Split rate (draft gold)           |         |         | 38% / 25% | 40% / 40% |
| False endpoints (draft gold)      |         |         | 6 / 4     | 8 / 8     |
| Endpoint latency p50 (draft gold) |         |         | 474 / 473 | 270 / 269 |

Calls 7 and 8, with the caller audio's VAD trace, replay closely. Calls 5 and 6 have no audio:
their VAD is modelled from the turns (speech from 200 ms before each turn opened to its last
voiced audio), which misses speech that never became a turn, so they replay fewer turns. Compare
a candidate with a replay of the baseline, never with the live numbers.

## The scorecard

Metrics marked _gold_ need a gold transcript and are `null` without one. Thoughts are the gold's
`thought` groups: a pause mid-sentence is not a new thought.

| Metric                           | Definition                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Split rate _gold_                | Thoughts the detector cut into two or more turns, over thoughts that want a reply.                                                             |
| Merge rate _gold_                | Thoughts with no turn of their own whose words a turn over a later thought took in.                                                            |
| False endpoints _gold_           | Turns that ended more than 250 ms before their thought's last word (the caller went on).                                                       |
| Turns on no thought _gold_       | Turns over no thought, or over a backchannel: noise, echo, a "hmm" answered.                                                                   |
| Endpoint latency p50/p90 _gold_  | From a thought's last word to the end of its last turn.                                                                                        |
| Replies composed, none heard     | Answered turns whose reply was composed but not a word of it heard (superseded, interrupted before audio).                                     |
| Reply lines discarded / cut      | Answer lines never heard / cut off after their audio started.                                                                                  |
| LLM requests per thought / turn  | Every LLM request (speculative ones too) over thoughts _gold_, or over answered turns.                                                         |
| Agent started over the caller    | Agent lines whose first audio came while the caller was speaking (gold utterances, else the VAD trace, else the turns), and for how long.      |
| Thoughts / turns with no reply   | A thought with no answer heard before the next thought (15 s at most) _gold_; an answered turn with no answer line heard.                      |
| Canned/fallback lines heard      | Clarification, say-again and uncertainty lines (the agent profile's patterns).                                                                 |
| Fillers heard                    | Filler and search lines heard.                                                                                                                 |
| First audio / first answer       | From an answered turn's last voiced audio to its first line heard / its first answer line heard, p50 and p90.                                  |
| Reply after last word _gold_     | From a thought's last word to the first answer heard for it, p50 and p90: what the caller waited.                                              |
| STT WER / CER _gold_             | The whole call's words in order against the gold (a final often spans utterances), each utterance by its closest rendering.                    |
| Wrong-language transcripts       | Segments in a script the caller's languages do not use, with letters English and romanised Hindi never need, or several common European words. |
| Utterances misdetected _gold_    | Those, plus English heard as Devanagari ("तेज इजाफा" for "Tejas").                                                                             |
| Turns begun < 1 s after the last | The no-gold proxy for splits.                                                                                                                  |
| Caller segments no turn answered | STT segments with words written while no answered turn was open and not within 2 s after one ended: coverage without gold.                     |

**Hinglish.** WER and CER compare words after romanising Devanagari (word-final schwa
dropped) and folding spelling: long vowels, aspirates, doubled letters, `w`/`v`, `z`/`j`,
`ph`/`f`/`p`. "हाँ ठीक है", "haan theek hai" and "han thik hai" are the same three words. It is
approximate on purpose and only for scoring. Numbers are compared as written.

## The regression gate

`--baseline <scorecard.json>` compares the run with a baseline and exits 1 when a metric is worse
beyond its threshold (`DEFAULT_THRESHOLDS` in `src/report/diff.ts`; `--thresholds <file>`
overrides them):

- on the aggregate: split, merge and false-endpoint rates +5 points, endpoint latency p50 +100 ms
  and p90 +250 ms, replies thrown away +1, discarded lines +2, LLM requests per turn or thought
  +0.15, talk-over +1, turns with no reply +1, first answer and reply latency p50 +150 ms and p90
  +400 ms, WER and CER +2 points, caller segments no turn answered +5 points, and none at all for
  missed replies, dropped thoughts, canned lines and wrong-language transcripts;
- on each call, for the zero-tolerance metrics;
- when a gated metric the baseline measured is `null` in the run (no turn answered leaves no
  latency or per-turn ratio to compare);
- and when a baseline call is missing from the run.

Fewer turns is not itself a regression (merging a split thought is the point of a better
detector), so turn coverage is gated without gold by the caller's segments no turn answered: a
detector that stops ending turns lowers every count it leaves behind, but not that one.

`scripts/mini-ci.sh` runs `eval:calls` in transcript mode against
`packages/eval/baselines/transcript-rules.json`: offline, no network, about 3 s. A change that
improves the calls passes; refresh the baseline in the same change so the next one is held to it:

```bash
pnpm eval:calls --label transcript-rules --save-baseline packages/eval/baselines/transcript-rules.json
```

Refresh it too when gold files are added or changed, since gold metrics are `null` without them.

## Bake-offs

**Turn detectors.** A detector is `rules` (the default detector with the agent's row and any
`--detector-config` over it) or `module:<path>[#export]`: a module whose export is a
`TurnDetectorFactory`, or a function of the row returning one (it may be async, to load a
model). Calls with a VAD trace replay the caller track through the carrier, so an audio-based
detector hears it; `--vad audio` runs the real energy VAD on the track too.

**STT.** `eval:calls stt-configs` lists the configurations (`src/audio/stt-configs.ts`): Scribe v2
realtime auto, pinned `en`, pinned `hi`, `en` with Hindi secondary and Maya's keyterms;
AssemblyAI universal-streaming English and multilingual; and, pending keys, Deepgram Nova-3
(multi, en-IN), Sarvam Saaras code-mix and OpenAI realtime. Cartesia Ink-2 is listed as
unavailable until its Wave 11 plugin merges: add its `create` there. At integration this list
becomes the STT lane's registry (`src/stt/configs.ts`, with each provider's options, prices and
docs confirmed), whose ids are `scribe-*`, `aai-*`, `deepgram-*`, `sarvam-*`, `cartesia-ink2` and
`openai-live-transcribe`; `stt-configs` prints whichever is in the tree. An audio run streams each
call in real time (call 8 is 4 minutes of audio), so it is billed; it saves what the STT wrote
per call under `<out>/<label>/transcripts/`, and `--transcripts` replays any detector over those
words offline, with no further spend.

**Keys** are read from the keys file (`--keys`, `KEY=value` lines, as in `~/.ovo-eval/keys.env`),
or from `OVO_EVAL_<name>` variables, into the process only: never printed, logged, or passed on
a command line. Live mode refuses a configuration whose key is missing.

## Adding a call

1. Export the call's events and turns, and its recording's caller track and manifest, into a
   raw corpus directory as `callN-events.jsonl`, `callN-turns.json`, `callN-caller.wav`,
   `callN-manifest.json`.
2. `pnpm eval:calls slim --from <raw dir> --to packages/eval/corpus --calls callN`, and add a
   label in `packages/eval/corpus/corpus.json`.
3. Have its gold written ([gold-format.md](gold-format.md)), then refresh the baseline.

## Limitations

- Open loop: the caller's words and timing are the live call's (see above).
- The modelled Scribe answers commits the live call never made with the words heard by then;
  what Scribe would really have finalised is unknown. The report counts these commits.
- Without caller audio the VAD is modelled from the turns (calls 5 and 6), less faithfully.
- The output's timing is modelled; real TTS first-byte times varied 140–360 ms.
- Language misdetection is a heuristic, not a language identifier.
- Maya's real agent config lives in the live database; the profile (`src/corpus/profile.ts`)
  carries her detector row, platform lines and a stand-in prompt. Replays answer from the
  recorded replies, so the prompt only matters to `--llm-model`.

Routing accuracy (which node, pool and agent a scripted caller reaches) is scored by a separate
harness, `pnpm eval:routing`; see [routing.md](routing.md).

## Code

| Path                       | What                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/corpus/`              | Corpus loading, gold files, the agent profile, WAV reading, VAD traces and the track offset     |
| `src/log/`                 | The event export and per-turn summaries                                                         |
| `src/timeline.ts`          | The timeline every call is scored on, live or replayed                                          |
| `src/replay/`              | The engine assembly, virtual time, the Scribe model, the recorded responder, the modes          |
| `src/audio/stt-configs.ts` | STT configurations and keys                                                                     |
| `src/score/`               | Segmentation, replies, STT and language, the metrics                                            |
| `src/report/`              | Markdown, HTML, the diff and the gate                                                           |
| `src/replay-kit/`          | The call 4–8 replay helpers promoted from the plugin tests (`@winsendotai/ovo-eval/replay-kit`) |
| `src/stt/`                 | The STT lane's bake-off code                                                                    |
