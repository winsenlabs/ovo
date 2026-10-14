# Turn bake-off: model-based end-of-turn detection (Wave 13, T1 to T3)

Status: evidence and a recommendation. **No production default changes in this wave.** The
production turn detector is still `@winsendotai/ovo-turn-detector-default` with
`PHONE_TURN_CONFIG`. The founder decides whether to adopt a model detector.

## The answer in one paragraph

On the two calls with real caller audio (calls 7 and 8, 30 caller thoughts), the current rules end
a turn while the caller is still mid-thought **13 times** (37% of thoughts get split). Pipecat
**Smart Turn v3.2** behind the new model gate does that **3 times** (10%), and asks the LLM 41
times instead of 51 (1.37 requests per thought instead of 1.70). It is built so that a held turn is
read again as the silence grows. The cost is endpoint latency: p50 rises from 621 to 810 ms and p90
from 844 to 1174 ms, plus about 60 ms of CPU per reading. Inference was measured at 62 ms p50 on
one thread of the mini's M4; a cloud vCPU will be slower. At threshold 0.3 Smart Turn costs almost
nothing in latency (p50 630, p90 1106) for 4 mid-thought endpoints instead of 3. LiveKit's audio
detector is as good on mid-thought endpoints, and its inference is cheaper (21 ms). But its licence
allows it only together with the LiveKit Agents framework, and that needs a legal answer first.
LiveKit's text model is deprecated and barely helps here (29% split rate against 32% for the rules
over all five calls). **Recommendation: Smart Turn v3.2, `recheckMs: 300`, threshold 0.5 (or 0.3
for speed), over the rules with their trailing-word holds removed.** Turn it on per agent behind a
shadow period. It needs one contract change first: the engine must pass the caller audio to the
turn detector (see "What production needs").

The corpus is small: 5 calls, 59 thoughts, and only 30 thoughts have audio. Treat the thresholds as
a starting point, not as tuned values. The harness is built so that every new call can be added in
minutes.

## What was built

| piece                          | where                                                                                                  | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model gate (T1 interface hook) | `packages/plugin-turns/src/model-gate*.ts`, `model-reading.ts`, `model-detector.ts`, `caller-audio.ts` | `createModelTurnDetector(row, model)`: the rules detector (`TurnController`) does everything it did before. These are barge-in, backchannels, mutes, the opening guard, DTMF, idle prompts, commits and noise handling. The gate sits on its `turn.stopped`. It has the model read the turn. If the model reads the turn as finished, the turn ends now. If the model reads it as unfinished, the turn is held for up to `holdMs`. Caller speech during the hold continues the same turn: one `turn.started`, one `turn.stopped` with all the words, and so one LLM request. `recheckMs` makes an audio model read a held turn again as the silence grows, and releases the turn once it reads as finished. The minimal safety rules are: short answers ("Yes.", "हाँ") end unread, words the STT broke off ("…any-") always wait, and optionally a question mark ends the turn at once. Model failures, timeouts (`timeoutMs`), unsupported languages and missing audio all fall back to the rules. `modelTurnDetectorPlugin(spec, load)` makes a turn-detector plugin for one model. The model loads once per process. |
| Smart Turn runtime             | `packages/plugin-turn-detector-smart-turn` (kind `kit`)                                                | Pipecat Smart Turn v3.2 (CPU int8 ONNX) on `onnxruntime-node` 1.30.0, with Whisper's log-mel front end in TypeScript. The front end is checked against transformers' `WhisperFeatureExtractor` (max abs diff 5e-6), and the end-to-end probability matches Python onnxruntime 1.31 exactly. `scripts/fetch-model.mjs` fetches the model at build time, pinned and SHA-256 checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| LiveKit runtimes               | `packages/plugin-turn-detector-livekit` (kind `kit`)                                                   | `turn-detector-v1-mini` (audio) through LiveKit Agents' own `inference.TurnDetector`, and the deprecated text model `v0.4.1-intl` through the runner LiveKit Agents registers for it. Its `scripts/fetch-model.mjs` fetches the text model files into the Hugging Face caches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Bake-off harness (T2)          | `packages/eval/src/turns/`                                                                             | Five pieces. The corpus: calls 4 to 8 as compact JSON (`corpus/`), rebuilt by `corpus-build.ts`, plus the caller WAVs for calls 7 and 8 from `~/work/ovo-waves`. The audio path: the production energy VAD run on the WAV, with the audio aligned to the event clock automatically (call 8: offset -1330 ms, 23 of 23 live VAD starts matched; call 7: -1090 ms, 12 of 16). The gold thoughts (`gold.ts`, `gold-overrides.ts`). The whole-call replay (`replay.ts`). The scorer, the report and the CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Method

**Replay.** Each call is replayed whole, on a fake clock, through each detector variant. The
detector hears the following at the times the live engine heard them:

- every Scribe interim and final, each final followed by Scribe's end-of-turn;
- the VAD's starts and stops: from the energy VAD on the caller WAV for calls 7 and 8, and modelled
  from the live turns for calls 4 to 6, as plugin-turns' Wave 10 replays do;
- the agent's speech, as `bot.started`/`bot.stopped`, with questions and fillers marked.

Audio models also get the caller audio in real-time 20 ms frames. Two things are identical for every
variant, by construction. First, the agent's lines keep their live timing: the caller's later words
answered them, so they cannot move. Second, Scribe's finals keep their live timing: a detector that
commits sooner would get its final up to that much sooner. Model inference takes no time on the
replay clock. Its measured cost is reported separately.

**Gold ("thoughts").** A thought is the unit one reply should answer. It is built from the caller's
speech runs, grouped while the caller holds the floor: a gap under 2 s, with no reply from the agent
starting in it, continues the thought. Words the STT sent with no speech run behind them are not
counted as the caller. Examples are an echo, a background talker that the VAD's caller gate ignored,
and noise that got transcribed. A thought expects no reply when it has no words, or when it is only
a backchannel said over the agent. Four corrections are in `gold-overrides.ts`, each with a reason:

- call 4 "Of January." is the caller, said softly;
- call 7 has Hindi over the greeting ("haan theek hai, aap isko laga do") from someone in the room;
- call 7 has garbled words over the agent;
- call 8 "Yes." confirming the dates is the caller, said softly.

**Founder review needed:** the corrections were read from the event logs, not checked by ear, and the
2 s floor rule is a judgement. The thoughts are listed per call in the generated report
(`turn-bakeoff.md` in the output directory). This is the turn lane's own gold v0. The STT lane's
word-level gold can later replace the runs and the words.

**Metrics.** Each speech `turn.stopped` is one LLM request. It belongs to the last
reply-expecting thought that started before it:

- **false endpoint**: the request came before that thought ended, so the caller was mid-thought. Its
  reply is made for half the thought and thrown away, which is the live "discarded replies".
- **split rate**: the share of thoughts with at least one false endpoint.
- **missed**: a thought with no endpoint before the next thought starts.
- **spurious**: a request for noise, or for a no-reply thought.
- **latency**: from the end of the caller's voice to the first endpoint after it, as p50 and p90.
  **slow** counts thoughts whose latency is over 1.5 s.

The `live` row scores what each call's live detector actually did. On the audio calls it reproduces
the founder's diagnosis: 53 requests for 30 thoughts, 15 of them mid-thought.

**Variants.**

- `rules`: production today (Wave 12 defaults).
- `rules-noholds`: the rules without their trailing-word holds (`cutoffHoldMs: 0`, which turns
  `pauseHoldMs` off too).
- `<model>`: the gate over `rules-noholds`, so the model decides what to wait for.
- `<model>+rules`: the gate over the full rules.
- `hold 1500`: a shorter hold.
- `+questions`: a question mark ends the turn unread.
- `recheck N`: re-read a held turn every N ms.
- `@T`: threshold T.

## Results

### Calls 7 and 8 (real caller audio, 30 thoughts)

| variant                               | LLM requests | per thought | false endpoints | split rate | missed | latency p50 ms |   p90 ms | slow (>1.5 s) |
| ------------------------------------- | -----------: | ----------: | --------------: | ---------: | -----: | -------------: | -------: | ------------: |
| live (what happened)                  |           53 |        1.77 |              15 |        43% |      0 |            623 |      847 |             1 |
| **rules** (production default)        |           51 |        1.70 |              13 |        37% |      0 |            621 |      844 |             1 |
| rules-noholds                         |           63 |        2.10 |              23 |        47% |      0 |            592 |      827 |             0 |
| smart-turn (read once, hold 2.5 s)    |           40 |        1.33 |               3 |        10% |      0 |            820 |     3210 |             8 |
| smart-turn hold 1500                  |           40 |        1.33 |               3 |        10% |      0 |            820 |     2282 |             8 |
| smart-turn hold 1500 +questions       |           45 |        1.50 |               7 |        20% |      0 |            704 |     2069 |             4 |
| **smart-turn recheck 300**            |       **41** |    **1.37** |           **3** |    **10%** |      0 |        **810** | **1174** |             2 |
| smart-turn recheck 300+rules          |           41 |        1.37 |               3 |        10% |      0 |            810 |     1174 |             2 |
| smart-turn recheck 150                |           43 |        1.43 |               5 |        17% |      0 |            790 |     1126 |             2 |
| **smart-turn@0.3 recheck 300**        |           42 |        1.40 |               4 |        13% |      0 |        **630** | **1106** |             1 |
| smart-turn@0.7 recheck 300            |           40 |        1.33 |               3 |        10% |      0 |            840 |     3079 |             6 |
| livekit-audio (read once, hold 2.5 s) |           37 |        1.23 |               1 |         3% |      0 |            910 |     3342 |            14 |
| livekit-audio+rules                   |           36 |        1.20 |               0 |         0% |      0 |            910 |     3342 |            14 |
| livekit-audio hold 1500               |           37 |        1.23 |               1 |         3% |      0 |            910 |     2394 |            14 |
| livekit-audio recheck 300             |           40 |        1.33 |               3 |        10% |      0 |            850 |     1256 |             2 |
| livekit-audio recheck 300+rules       |           39 |        1.30 |               2 |         7% |      0 |            850 |     1256 |             2 |
| livekit-audio@0.2 recheck 300         |           46 |        1.53 |               8 |        27% |      0 |            790 |      964 |             1 |
| livekit-text (deprecated)             |           47 |        1.57 |              10 |        30% |      0 |            741 |     1100 |             3 |

### All five calls (text model and rules only; calls 4 to 6 have no audio, 59 thoughts)

| variant            | LLM requests | false endpoints | split rate | missed | p50 ms | p90 ms |
| ------------------ | -----------: | --------------: | ---------: | -----: | -----: | -----: |
| live               |           93 |              27 |        37% |      1 |    650 |    943 |
| rules              |           89 |              24 |        32% |      2 |    694 |   1022 |
| rules-noholds      |          106 |              36 |        39% |      0 |    633 |    845 |
| livekit-text       |           85 |              20 |        29% |      1 |    741 |   1408 |
| livekit-text+rules |           83 |              20 |        29% |      3 |    741 |   1266 |

Per call, the rules and the live detector split call 8 the most (9 false endpoints of 28 requests,
47%). Call 6 hardly at all (1 of 12). The text model removes 3 of call 8's 9 and changes nothing
anywhere else.

### What the numbers say

1. **The rules' holds are worth something, but not much.** Removing them (`rules-noholds`) adds 10
   mid-thought endpoints on the audio calls. The rules catch about half of the caller's pauses that
   the VAD lets through. They miss the other half because Scribe writes a full stop at most pauses:
   "…Budapest, Vienna, Austria." then "Hungary, Zagreb, Croatia." (call 8), and "December." /
   "22nd." / "To January 5th." (call 8, three live turns and two discarded replies).
2. **Both audio models hear what the text cannot.** They hold on intonation, so "December." said
   with a rising, list-continuing pitch is held while the full stop says it is complete. Smart Turn
   removes 10 of the 13 mid-thought endpoints. LiveKit's audio model removes 10 to 13.
3. **Reading once and holding is too slow.** Both models read some complete turns as unfinished
   (Smart Turn 8 of 30, LiveKit 14 of 30), and the caller then waits out the whole hold (p90 3.2 to
   3.3 s). Pipecat and LiveKit Agents both read once. **Re-reading the held turn every 300 ms
   (`recheckMs`)** fixes most of these: the audio now ends on 0.5 to 1 s of silence, and the models
   read it as finished. Slow endpoints drop from 8 to 2 (Smart Turn) and from 14 to 2 (LiveKit)
   without losing the gain. This is the gate's own addition, and it is why the recommended
   configuration differs from both frameworks' defaults.
4. **The remaining false endpoints** for Smart Turn recheck 300:
   - call 7 t2: "Hi, Maya… a trip." then "Sometime in December to…": the caller restarted after a
     pause that read as complete;
   - call 8 t3: "January back to Chennai." / "So round trip to Frankfurt…";
   - call 8 t11: "…मेरा नाम है तेजस?" then, 1.6 s later, "आप कौन हो?".

   The last two are arguably two thoughts. A 1.5 s gap would split them, and the gold is a judgement
   there.

5. **The text model is not worth it.** On the audio calls it removes 3 of 13 mid-thought endpoints
   and adds latency. Over all calls it removes 4 of 24. LiveKit itself deprecated it in
   agents-plugin-livekit 1.9 in favour of the audio model, and it is a 396 MB download.
6. **`+questions` (a question mark ends the turn) is not safe:** it doubles the false endpoints.
   Scribe adds question marks to unfinished questions ("Is it safe to go there now? | As a
   tourist?").

### Expected latency impact of the recommendation

Endpoint latency is from the caller's last sound to the request for the LLM.

- **Smart Turn, threshold 0.5, recheck 300:** p50 621 → 810 ms (+190), p90 844 → 1174 ms (+330),
  plus about 60 ms of inference per reading.
- **Smart Turn, threshold 0.3:** p50 630 (+10), p90 1106 (+260), with 4 mid-thought endpoints
  instead of 3. On this corpus this is the better trade. Confirm it on more calls.

Each mid-thought endpoint avoided saves a discarded reply. It also saves the 1 to 3 s that the
caller live spends hearing the agent start, stop and start again, so the net effect on the
conversation is positive, but that is a judgement, not a measurement.

**CPU cost.** Measured on the mini (Apple M4) on 8 s windows.

- **Smart Turn total:** about 60 ms per reading on 1 thread (`threads: 1`, the default chosen so that
  one call never takes the worker's cores), and about 40 ms on 2 threads.
  - Feature extraction is 23 ms of that, in JavaScript. It is a candidate for later optimisation.
  - The ONNX inference is about 35 ms.
- **LiveKit v1-mini:** 21 ms (native, 1.2 s window).
- **LiveKit text:** 20 ms.

With `recheckMs: 300` a held turn costs about 3 readings a second while it is held. That is about
20% of one core per call that is in a hold, and nothing otherwise. Expect cloud vCPUs to be 1.5 to
3x slower than the M4. The gate's `timeoutMs` (1 s) bounds the damage: a slow reading ends the turn
as the rules decided.

## The candidates (sources retrieved 2026-10-14)

| model                                                                                                                                   | input                              | licence                                                      | size                                                                                                  | languages (Hindi?)                                                                | CPU latency (mini)                        | source                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pipecat Smart Turn v3.2** (`smart-turn-v3.2-cpu.onnx`, HF `pipecat-ai/smart-turn-v3@f766f81d`, sha256 `2bb02631…`)                    | audio, 16 kHz, last 8 s            | **BSD-2-Clause** (code and weights; "truly open model")      | 8.7 MB int8 (32 MB fp32 GPU build)                                                                    | 23, **Hindi yes** (benchmark: Hindi 90.1%, English 94.3% accuracy; overall 92.6%) | about 60 ms on 1 thread, about 40 ms on 2 | https://github.com/pipecat-ai/smart-turn (README, inference.py), https://huggingface.co/pipecat-ai/smart-turn-v3 (benchmarks/smart-turn-v3.2-cpu.md, generated 2026-01-07) |
| **LiveKit turn-detector-v1-mini** (in `@livekit/local-inference` 0.2.7, a dependency of `@livekit/agents` 1.9.0, already in OVO's tree) | audio, 16 kHz, last 1.2 s          | **LiveKit Model License** (weights); package code Apache-2.0 | weights compiled into the native binary (darwin-arm64 33 MB, linux-x64-gnu 34.9 MB); "~108 MB" loaded | 14 thresholds, **hi 0.305**, en 0.36                                              | 21 ms                                     | `@livekit/agents` 1.9.0 `dist/inference/eot/*`, `@livekit/local-inference/index.d.ts` and MODEL_LICENSE                                                                    |
| LiveKit turn-detector v0.4.1-intl (HF `livekit/turn-detector`, Qwen2.5-0.5B distilled)                                                  | text plus up to 6 turns of history | **LiveKit Model License**                                    | 396 MB int8 ONNX plus an 11 MB tokenizer                                                              | 14, **Hindi yes**                                                                 | 20 ms                                     | https://huggingface.co/livekit/turn-detector (card, LICENSE). **Deprecated** in `@livekit/agents-plugin-livekit` 1.9 ("the audio EOT detector … replaces it")              |
| Namo Turn Detector v1 Multilingual (VideoSDK)                                                                                           | text                               | Apache-2.0                                                   | 309 MB int8                                                                                           | 23, Hindi yes                                                                     | not measured                              | https://huggingface.co/videosdk-live/Namo-Turn-Detector-v1-Multilingual. Not evaluated: text models showed little here                                                     |

**LiveKit Model License** (https://huggingface.co/livekit/turn-detector/blob/main/LICENSE, last
updated 2024-11-25, the same text as `@livekit/local-inference`'s MODEL_LICENSE). It grants free use
and redistribution, "as a condition", (i) "not to use any LiveKit Models on a standalone basis or
with any frameworks other than LiveKit Agents" and (ii) not to use their outputs to develop other
models. OVO depends on LiveKit Agents: `@livekit/agents` 1.9.0 is in plugin-engine-livekit and in all
four apps. This harness therefore reaches both LiveKit models only through LiveKit Agents' own
classes:

- the audio model through `inference.TurnDetector` with an in-process executor, the framework's
  documented override seam;
- the text model through the runner the framework registers.

It never calls the weights directly. **Using either model in OVO's native engine (plugin-voice and
plugin-turns) is a different question.** It is arguably "with another framework", so it needs a
legal reading before production use. The clean option is the LiveKit engine
(`plugin-engine-livekit`), where `turnDetection: new inference.TurnDetector()` is plainly licensed.
Smart Turn has no such condition. That condition, together with the equal or better numbers, is why
Smart Turn is the recommendation.

## Deployment facts

- **Model files.** Smart Turn is fetched at build time (`OVO_TURN_MODELS_DIR=<dir> node
packages/plugin-turn-detector-smart-turn/scripts/fetch-model.mjs`). The script pins the revision,
  checks the SHA-256 and writes a NOTICE beside the file. It is not vendored in git: 8.7 MB of
  binary weights would sit in every clone, and BSD-2 allows either choice. LiveKit v1-mini needs
  nothing: it ships inside `@livekit/local-inference`.
- **Worker image size.**
  - Smart Turn: +8.7 MB of model, plus `onnxruntime-node` 1.30.0. That package is 287 MB unpacked
    with every platform's binaries, of which linux/x64 is 46 MB (`libonnxruntime.so.1` 45.8 MB).
    Pruning the other platforms' `bin/napi-v6/*` in the image build keeps the cost at about 55 MB.
  - LiveKit audio: +0 MB. `@livekit/local-inference-linux-x64-gnu` (34.9 MB) is already in the image
    through `@livekit/agents`.
  - The LiveKit text model would add 396 MB, plus `@huggingface/transformers` and `sharp` (whose
    libvips binaries are LGPL-3.0-or-later). Not recommended. They are dev dependencies of the kit
    (bake-off only), so a production install has none of them.
- **linux/amd64 glibc (node:24.8.0-bookworm-slim, glibc 2.36).**
  - `onnxruntime-node` 1.30.0's `linux/x64` binaries need GLIBC_2.28 and GLIBCXX_3.4.22 at most.
  - `@livekit/local-inference-linux-x64-gnu` 0.2.7 needs GLIBC_2.34 and GLIBCXX_3.4.21. bookworm
    provides both, and libstdc++6 is already in the Node image.

  This was checked statically on the binaries (`strings`). Following the no-local-docker rule, it
  was not run in a container. **Darwin/arm64 (the mini)** runs both, and that is where the bake-off
  ran.

- **Install scripts.** `onnxruntime-node`'s postinstall (it downloads optional CUDA/TensorRT
  providers) stays unapproved under pnpm 10, which ignores it. The CPU binaries are in the package
  itself. Do not approve it.
- **One process, one onnxruntime.** The LiveKit text model loads `onnxruntime-node` 1.24.3 (through
  transformers), and Smart Turn loads 1.30.0. The two native libraries crash when loaded into one
  process, so the CLI runs the text model in a child process. Never ship both in one worker.

## What production needs before the switch (not built: owned elsewhere)

1. **The caller audio must reach the turn detector.** `TurnDetectorFactory.create` gets no audio
   today. The gate takes it through `ModelGatedTurnController.audio(pcm, rate)`, but no engine calls
   that yet. Without it, an audio-model detector reads no turn and acts exactly like the rules
   without holds, which is worse than today. Proposed contract and engine change, for the founder
   to assign:

   ```diff
   // packages/contracts/src/voice/turn.ts
    export interface UserTurnController {
      observe(event: VoiceEvent): void;
      on(fn: (decision: TurnDecision) => void): () => void;
      dispose(): void;
   +  /** Optional: the caller's audio (the VAD's copy, 8 or 16 kHz mono PCM), frame by frame. */
   +  audio?(pcm: Int16Array, rate: 8000 | 16000): void;
   +  /** Optional: each line the agent starts to speak (a text model reads it as context). */
   +  agentSaid?(text: string): void;
    }
   // packages/plugin-voice/src/engine/ingress-vad.ts (IngressVad.analyze), after decode(),
   // sketch: IngressVad is given the session's turn controller (or a callback to it)
   +    this.onAudio?.(pcm, this.format.sampleRate as 8000 | 16000);
   ```

   Both members are optional, so every existing detector is unaffected.

2. **Register the plugin in the distribution** (the composition root may import both plugin-turns
   and the runtime; a plugin may not import another plugin):

   ```ts
   modelTurnDetectorPlugin(
     { id: '@winsendotai/ovo-turn-detector-smart-turn', provider: 'pipecat' },
     async () => {
       const { SmartTurnModel, SMART_TURN } =
         await import('@winsendotai/ovo-plugin-turn-detector-smart-turn');
       return SmartTurnModel.load({
         modelPath: join(env.OVO_TURN_MODELS_DIR, 'smart-turn', SMART_TURN.file),
       });
     },
   );
   ```

   Agents then opt in with `voice.turnDetector = { plugin: '@winsendotai/ovo-turn-detector-smart-turn',
config: { cutoffHoldMs: 0, model: { recheckMs: 300 } } }`. The default stays the rules.

3. **Image build.** Set `OVO_TURN_MODELS_DIR`, run the fetch script, and prune `onnxruntime-node`'s
   non-linux/x64 binaries.
4. **Shadow first.** Run the gate with its decisions logged but not applied for a week of calls (a
   `shadow: true` gate option, about 20 lines, not built). Run this harness on every new call with
   audio, and switch per agent once the numbers hold.

## Migration plan: which rules go if the model wins

The gate keeps the rules for everything the model does not decide. If Smart Turn holds up in shadow
and A/B, these rules become dead weight and should be deleted, in this order, each with its replay
tests:

1. The trailing-word holds:
   - `cutoffHoldMs` and `pauseHoldMs` (config.ts);
   - `CutoffHold` (transcript-text.ts);
   - the `pause`/`hold` endpoint paths in the controller.

   The model's hold replaces them. The variants above already run with them off.

2. The Wave 8b carry-on merge of a turn that trailed off (`CARRY_ON_MS`, `trailedOff` in
   controller-state.ts). The gate's continuation merges more generally.
3. The parts of `utteranceEnd` that only feed the holds: `NOT_LAST` and `NEVER_LAST` as hold
   triggers, `rangeAwaitsMonth`, and `numberGoing`.
4. **Keep:** the commit timing (`commit.*`: when to ask Scribe for its final), barge-in, the
   backchannel and mute rules, the opening guard, DTMF, idle prompts, noise handling,
   `answersByItself` (the gate's short-answer safety uses it), and `endsCutOff` (its broken-off
   safety).

## Provider-side turn signals: Cartesia Ink-2 and Deepgram Flux (design, not built)

Both providers end turns themselves, semantically, and the contracts already have the events for
it: `SttEvent` `speech-start`, `end-of-turn { eager?, confidence? }`, `turn-resumed`, and
`turnSignals` in `SpeechCapabilities`. The detector's `provider` strategy ends turns on them.

- **Cartesia Ink-2, "Auto" endpoint** (`wss://api.cartesia.ai/stt/turns/websocket`, models
  `ink-2`/`ink-preview`, languages en/fr/hi/ja/es auto-detected; https://docs.cartesia.ai/use-the-api/stt/turns.md,
  retrieved 2026-10-14; Wave 11 research `/tmp/ovo/w11-research-cartesia.md`).

  | Cartesia event   | OVO event                                        |
  | ---------------- | ------------------------------------------------ |
  | `turn.start`     | `speech-start`                                   |
  | `turn.update`    | interim `transcript` (cumulative, never revised) |
  | `turn.eager_end` | `end-of-turn { eager: true }`                    |
  | `turn.resume`    | `turn-resumed`                                   |
  | `turn.end`       | final `transcript` plus `end-of-turn`            |

  Capabilities: `turnSignals: ['speech-start', 'end-of-turn', 'turn-resumed']`,
  `forceEndpoint: false`. The thresholds (`start` 0.8, `eager_end` 0.6, `end` 0.3,
  `end_timeout_ms` 5600) map to the plugin's row config. The mid-session `config` message maps to
  `SttConfigurationUpdate`, so a tighter end can follow a yes/no question. Wave 11's
  `plugin-stt-cartesia` (PR #11, not merged) is the place for it.

- **Deepgram Flux** (`wss://api.deepgram.com/v2/listen`, `flux-general-en` or `flux-general-multi`,
  10 languages including **hi**, with optional `language_hint`;
  https://developers.deepgram.com/docs/flux/quickstart and /docs/flux/language-prompting,
  retrieved 2026-10-14). It accepts mulaw at 8 kHz natively.

  | Flux `TurnInfo` event | OVO event                               |
  | --------------------- | --------------------------------------- |
  | `StartOfTurn`         | `speech-start`                          |
  | `Update`              | interim                                 |
  | `EagerEndOfTurn`      | `end-of-turn { eager: true }`           |
  | `TurnResumed`         | `turn-resumed`                          |
  | `EndOfTurn`           | final plus `end-of-turn { confidence }` |

  Parameters: `eot_threshold` 0.7 (0.5 to 1.0), `eager_eot_threshold` (0.3 to 0.9, off by
  default), `eot_timeout_ms` 5000 (500 to 60000). This is a new `/v2` mode in
  `plugin-stt-deepgram`, which is pending a key.

- **How they meet the gate.** A provider's `end-of-turn.confidence` is an end-of-turn probability
  computed on its own audio. The gate's `EndOfTurnModel` can wrap it (`input: 'text'`; `predict`
  returns the last confidence), so the same hold, continuation and safety logic and this same
  bake-off apply. To compare them: add the provider STT to the eval lane's audio replay. Record its
  turn events against the WAV (keys pending), and score the provider strategy and provider-plus-gate
  here. The eager events can drive speculative LLM requests (`turn.partial` with `stable`), which
  the engine already supports.

## Reproduce

On the mini, from the worktree:

```sh
# models (once): Smart Turn into the models dir; the LiveKit text model into the HF caches
OVO_TURN_MODELS_DIR=~/.ovo-eval/models node packages/plugin-turn-detector-smart-turn/scripts/fetch-model.mjs
(cd packages/plugin-turn-detector-livekit && node scripts/fetch-model.mjs)
# the bake-off (about 70 s): writes turn-bakeoff.json / .md
OVO_TURN_MODELS_DIR=~/.ovo-eval/models npx tsx packages/eval/src/turns/cli.ts --sweep --out /tmp/turn-bakeoff
# the offline subset (no audio, no models): runs in vitest with everything else
npx vitest run packages/eval/src/turns
```

`corpus-build.ts` rebuilds `corpus/*.json` from the raw exports. Add a new call there, plus its WAV
in the corpus directory and any gold overrides, and rerun.

## Not done in this wave

- Production wiring: the audio contract, the engine call, the distribution entry and the image
  build. These are owned elsewhere; see above.
- Shadow mode.
- More calls. The thresholds are fitted to 30 audio thoughts.
- A container run on linux/amd64. Checked statically only.
- The STT lane's word-level gold, which this gold should adopt.
- Cartesia and Flux are designed only (keys pending, Wave 11 unmerged).
