# STT bake-off on calls 7 and 8 (Wave 13)

Status: evidence and a recommendation. No production default has changed; the founder decides. Recorded 2026-10-14 from the mini (not the asia-south1 VM, so absolute latencies include the mini's network).

## What was measured

The corpus is the caller track of the two calls with real two-track audio: call 7 (`8cb76efc`, 273 s) and call 8 (`eb509d62`, 244 s). An offline speech finder cut each track into regions. Each region was then reconciled into a gold transcript (`packages/eval/corpus/gold/call7.json`, `call8.json`; the format is [gold-format.md](gold-format.md)):

|                                                         | Call 7                                               | Call 8                             |
| ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| Gold utterances (speech)                                | 28 (16 high, 5 medium, 7 low confidence)             | 17 (8 high, 9 medium)              |
| Caller thoughts (utterances a reply should follow once) | 21                                                   | 15                                 |
| Languages                                               | English 28                                           | English 12, Hindi 3, Hinglish 2    |
| Regions without words (`nonSpeech`)                     | 9                                                    | 8                                  |
| Speech time                                             | 84 s                                                 | 55 s                               |
| Track offset (call time = track + offset)               | −640 ms (14 turn starts matched, median error 20 ms) | −789 ms (20 matched, median 20 ms) |

Each configuration streamed every region of both calls in real time on one session per call. The audio went as 20 ms frames of 8 kHz μ-law through the production OVO plugin and the host's format adapter, as a live call frames it. Commits were sent where OVO's energy VAD (the phone row, run over the whole track) stopped, so each configuration received the same host commits that a live call would have sent.

The replay is not the whole call, though. Only the regions were sent: about 280 s per configuration of the 517 s of track. After each region the runner sent digital silence until the final arrived, then moved to the next region. The recorded track between bursts is not digital silence: it sits at the μ-law codec floor (±8 on 72% of call 7's samples and 73% of call 8's). The replay is therefore faithful for what is said inside a region, and weaker evidence for what an STT does with the line noise between regions (see finding 4).

These metrics were recorded:

- **WER and CER**: computed by the call-eval harness's own scorer (`packages/eval/src/score/wer.ts`), so these gold files give one WER whichever tool reads them. Both sides are romanised and spelling-folded first (`score/hinglish.ts`), so "mera naam", "mera nam" and "मेरा नाम" match. The transcript is scored against the closest gold rendering (romanised, Devanagari or `accept`). Hesitations (uh, um, hmm) count as words, as the shared scorer has them; dropping them lowers every WER by 0.3 to 1.3 points and changes no ranking. Low-confidence gold utterances are excluded.
- **Call WER**: each call is scored as one transcript, so it does not matter which region a late final lands in.
- **Wrong language**: transcripts in a language the caller did not speak, judged by script, by foreign letters (ä, ı, ñ) or by function words (aber, nicht, bueno). Regions where the provider itself reported such a language are counted separately.
- **Noise words**: words shown (finals, or partials that never finalised) over regions with no caller words.
- **Final after speech**: the time from the end of the caller's speech to the last final. It includes the VAD's 200 ms stop.
- **Cost**: the list price per minute of audio, from the sources in `packages/eval/src/stt/configs.ts` (retrieved 2026-10-14).

## Results

| Config                           | Utterances | WER      | CER      | Call WER | WER en | WER hi    | Wrong language (text / reported) | Empty | Noise words | Final after speech p50 / p90 ms | No final | $/min (list) |
| -------------------------------- | ---------- | -------- | -------- | -------- | ------ | --------- | -------------------------------- | ----- | ----------- | ------------------------------- | -------- | ------------ |
| live-call (what the calls got)   | 38         | 13.9%    | 11.9%    | 10.1%    | 13.0%  | 23.3%     | 6 / –                            | 2     | 32          | –                               | –        | $0.0078      |
| scribe-auto (production binding) | 38         | 10.9%    | 7.3%     | 10.9%    | 8.3%   | 41.4%     | 2 / 6                            | 0     | 25          | 444 / 568                       | 3        | $0.0078      |
| scribe-en                        | 38         | 9.2%     | 6.5%     | 9.2%     | 6.8%   | 37.9%     | 0 / 3                            | 0     | 29          | 442 / 557                       | 2        | $0.0078      |
| scribe-hi                        | 38         | **8.7%** | **5.7%** | **8.7%** | 7.4%   | 24.1%     | 5 / 39                           | 0     | 29          | 429 / 566                       | 2        | $0.0078      |
| scribe-en-hi (en, secondary hi)  | 38         | 10.0%    | 8.3%     | 9.8%     | 7.1%   | 44.8%     | 1 / 8                            | 0     | 31          | 427 / 581                       | 2        | $0.0078      |
| scribe-en-keyterms               | 38         | 11.2%    | 7.1%     | 11.2%    | 7.1%   | 58.6%     | 0 / 3                            | 0     | 28          | 427 / 570                       | 5        | $0.0078      |
| aai-english                      | 38         | 38.6%    | 32.2%    | 25.6%    | 34.2%  | 92.6%     | 0 / –                            | 2     | 17          | 312 / 790                       | 7        | $0.0032      |
| aai-multilingual                 | 38         | 48.8%    | 40.8%    | 35.1%    | 44.3%  | 100.0%    | 0 / –                            | 4     | 18          | 294 / 872                       | 8        | $0.0025      |
| **aai-u3pro-hi-en**              | 38         | **8.7%** | **5.7%** | **8.7%** | 8.3%   | **13.8%** | **0** / –                        | 0     | 26          | **392 / 468**                   | 2        | $0.0075      |

The Scribe configurations all use `scribe_v2_realtime` with a manual commit and the `Maya` keyterm; the keyterms configuration adds 14 travel terms. AssemblyAI bills the session rather than the audio sent; with keyterms the English model costs $0.19/h, and the U3.6 Pro model costs $0.45/h with keyterms included. AssemblyAI reports languages only with `language_detection`, which the plugin does not request, so its "reported" column is empty. The live-call row scores the finals the calls actually received, matched to regions by arrival time; it has no latency figures.

Regenerate the table (offline, no keys): `pnpm exec tsx packages/eval/src/stt/cli.ts score`. Every utterance's transcripts from every configuration follow the table in that output.

### How far to trust these numbers

- **The sample is small.** It covers 38 scored utterances from two calls, with one caller (the founder) on one phone. The Hindi column rests on 5 utterances (29 words), all in call 8. A 2-point WER gap between configurations is noise.
- **The gold is reconciled from these same systems.** Nobody listened to the audio. Where model families disagreed, two batch models had the most weight: Scribe v2 batch and AssemblyAI Universal-3.5 Pro. They hear whole sentences with context in both directions. On the Hindi utterances, AssemblyAI batch usually decided the wording, which favours AssemblyAI U3.6 Pro (the same vendor) in the Hindi column. The 7 low-confidence utterances (all call 7) are excluded from the error rates and listed in `needsFounderReview`. The 5 Hindi and Hinglish utterances of call 8 (c8-u06, c8-u11, c8-u12, c8-u13, c8-u14) are scored but should be heard before the Hindi column is trusted, since AssemblyAI batch settled most of their wording. They are not in `needsFounderReview`, because the call-eval harness treats every utterance listed there as low-confidence and would drop all of call 8's Hindi from its scoring. The `reasoning` of each utterance says which transcripts agreed.
- **Scribe's language choice is not deterministic.** Replaying call 8 did not reproduce the live call's German ("Ah, aber, äh, war noch nicht.") on c8-u02, although the live call and the replay sent the same audio with the same binding.

## Findings

1. **Wrong-language text comes from Scribe's auto-detection on short commits.** The live calls received German, Turkish, Spanish, Tamil and Cyrillic text, and Hindi for English ("यार, अच्छा नहीं।" for "Yeah, that's right."). In the replay, scribe-auto still produced Cyrillic ("Яяя, м-м-м..." for "Yeah, hmm...") and Spanish, and it reported Italian, German, Spanish and Russian for commits whose text was English. Pinning `en` (scribe-en) produced no wrong-language text. It still wrote the Hindi utterances in Devanagari ("आप कौन हो?"), so the pin does not stop Hindi being transcribed. Pinning `hi` mostly writes English in Latin script, but it reports `hi` for every commit and wrote 5 regions in the wrong script.
2. **AssemblyAI Universal-3.6 Pro with `language_codes` hi+en was the most accurate and the fastest.** It tied scribe-hi for the lowest WER and CER (8.7% and 5.7%), had by far the best Hinglish result (13.8% against 24.1% for the next best), wrote no wrong-language text (scribe-hi wrote 5), and had a final 468 ms after speech at p90, against about 570 ms for Scribe. It heard "What is Zagreb special for?" and "How does it work?" where every Scribe binding cut the first short ("What is Zagreb's-") and misheard the second ("No, just the dog.", "No, no children."), and it heard "Brandenburg Tor" without keyterms. The Hindi caveat above applies.
3. **AssemblyAI Universal-Streaming English and Multilingual do not fit OVO's host commit.** Their recognition runs about a second behind the audio. A `ForceEndpoint` at the VAD stop finalises what has been recognised so far, and the rest of the sentence lands in the next turn: "...what do you think about" / "this itinerary why do it sound". The call-level WER (25.6% and 35.1%) is the fairer figure, and it is still three to four times worse. Multilingual has no Hindi.
4. **The live calls turned near-silence into turns.** Call 8 opened six user turns over stretches where the recorded caller track is at the codec floor (−67 to −72 dBFS): "Hıhı.", "Question 4.", "No, no, no, no", "मेरा नाम है तेज इजाफा करना है क्या?", "." and ".". Call 7 opened three: "It's a machine.", "Please." and "Yeah.". Replaying that audio produced no finals from any configuration, only partial "Hello?" from some Scribe bindings. So either the live STT received audio that the recording does not hold (for example, the recording is gated or the STT input is not), or Scribe hallucinates on silence non-deterministically. Both possibilities matter more than WER: these phantom turns are part of call 8's 29 turns for about 15 thoughts. One difference weakens the replay here: it sent each such region on its own after digital silence, where the live STT had been hearing the codec floor continuously. A model that adapts to the line may behave differently on the same region. Streaming one whole track continuously through scribe-auto (about 4 minutes of audio) would settle that. **This needs a check of the worker's STT input against the recorded track (turns and eval lanes).**
5. **Keyterms are a trade.** The travel keyterms fixed "Brandenburg Tor" (the live call heard "Brandon, Bakhtar"), but cost two points of WER against scribe-en, most of it on Hindi (58.6% against 37.9%). On a 3 s region without words (c8-u10), three Scribe bindings with the `Maya` keyterm wrote "Maya, Maya, Maya, Maya, Maya, Maya, Maya, Maya.", and the keyterms binding wrote "Maya, Maya,". Both batch models wrote nothing. No Scribe binding without the keyterm was run, so the agent-name keyterm is suspected, not proven.
6. **Plugin defect, fixed in this wave.** Scribe refuses a commit that closes less than 0.3 s of audio (`commit_throttled`: "You need at least 0.3s of uncommitted audio before committing") and then closes the socket (1000 `commit_throttled`). The plugin had treated the notice as harmless, so the session died on the next write and the rest of the call lost its transcription. The bake-off hit this live on both calls. Every commit now closes at least 320 ms (padded with silence), and a close for that reason is retryable (commit 4426337, with a regression test).
7. **Scribe batch translates Hindi.** With `scribe_v2` batch and auto language, the Hindi utterances came back in English ("My name is Tejas. What is your name?"). It is fine for gold candidates and wrong for transcripts.

## Recommendation

1. **Now, a configuration change (no code): pin Scribe to English for en-IN agents.** Set `languageMode: "session"` and `sessionLanguage: "en"` on Maya's STT binding. On this corpus the pin removed every wrong-language transcript, which are the ones that reach the LLM as German or Turkish. English accuracy did not drop (WER en 6.8% against 8.3%), and Hindi is still transcribed in Devanagari, no worse than with auto-detection (37.9% against 41.4%, on 5 utterances, so the gap is noise). Keep `languageDetection: true` on the binding, so that each call logs the language Scribe detected for every commit (`stt_language_detected`). Before deciding, **listen to the 7 low-confidence utterances** in `needsFounderReview` and call 8's 5 Hindi and Hinglish ones.
2. **Next, a live A/B: AssemblyAI Universal-3.6 Pro with `language_codes: ["hi","en"]`.** It tied for the best WER and CER, won the Hindi column by a wide margin, wrote no wrong-language text and had the best p90 latency, at a similar price. scribe-hi matched its overall WER but reported `hi` for every commit and wrote 5 regions in the wrong script, so it is not a candidate. Two prerequisites:
   - **The language codes.** The plugin sends `language_codes` only when the session language is `hi-IN` (or another `-IN` language). An en-IN agent either needs its session language set to `hi-IN` or a binding field for the codes; the binding field is a plugin change for a later wave.
   - **Live validation.** The bake-off proves the handshake works (both calls streamed every region without an error) but not that the codes are honoured rather than ignored: the Begin message was not captured.

   Run 10 to 20 real calls on each binding and score them with this tool before any switch.

3. **Do not** use AssemblyAI Universal-Streaming English or Multilingual with OVO's host commit. **Do not** add broad keyterms until the "Maya ×8" effect is tested with and without the agent-name keyterm.
4. **Phantom turns over silence** (finding 4) are not an STT configuration question. Compare the worker's STT input with the recorded track, and have the turn detector require VAD speech before it opens a turn on transcript text alone.

## What to run when keys arrive

The runner already includes these configurations; `status` lists them as `pending key` or `pending plugin`. Put the key in `~/.ovo-eval/keys.env` under the names below, then stream both calls through each configuration (about 4.6 minutes of audio per configuration):

```bash
pnpm exec tsx packages/eval/src/stt/cli.ts status --keys ~/.ovo-eval/keys.env
OVO_LOG_LEVEL=warn pnpm exec tsx packages/eval/src/stt/cli.ts record --corpus ~/work/ovo-waves \
  --configs deepgram-nova3-multi,deepgram-nova3-en-in --keys ~/.ovo-eval/keys.env
pnpm exec tsx packages/eval/src/stt/cli.ts candidates   # refresh the gold candidates
pnpm exec tsx packages/eval/src/stt/cli.ts score
```

| Configuration                                          | Key                | What to look for                                                                                                    | Options confirmed (source, 2026-10-14)                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepgram-nova3-multi`                                 | `DEEPGRAM_API_KEY` | Hinglish code-switching against U3.6 Pro; whether `keyterm` works with `language=multi` (not documented)            | Nova-3 `multi` covers en, es, fr, de, hi, ru, pt, ja, it, nl; results carry `languages` ([models-languages-overview](https://developers.deepgram.com/docs/models-languages-overview), [multilingual-code-switching](https://developers.deepgram.com/docs/multilingual-code-switching))                                                |
| `deepgram-nova3-en-in`                                 | `DEEPGRAM_API_KEY` | Indian English accuracy with the language pinned                                                                    | `en-IN` as a Nova-3 English variant is unconfirmed on the fetched page                                                                                                                                                                                                                                                                |
| `sarvam-saaras-v3-codemix`, `sarvam-saaras-v4-codemix` | `SARVAM_API_KEY`   | Hindi and Hinglish; its own VAD endpointing (no `forceEndpoint`), so time to final depends on `silence_duration_ms` | `/speech-to-text-realtime/ws`, `saaras:v3-realtime` or `saaras:v4`, `mulaw` encoding, `mode=codemix` ([realtime-streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)). The older `/speech-to-text/ws` reference lists no mulaw, so check that the handshake accepts the plugin's parameters. |
| `openai-live-transcribe`                               | `OPENAI_API_KEY`   | Accuracy with no language set; it returns no confidence and no word timings                                         | `gpt-live-transcribe` takes `languages` (plural) and `keywords`, with `turn_detection` null ([realtime-transcription](https://developers.openai.com/api/docs/guides/realtime-transcription))                                                                                                                                          |
| `cartesia-ink2`                                        | `CARTESIA_API_KEY` | Hinglish with automatic language detection and its own turn events                                                  | ink-2 covers en, fr, hi, ja, es with no language parameter ([stt/latest](https://docs.cartesia.ai/build-with-cartesia/stt/latest)). **Pending plugin**: the Wave 11 plugin (PR #11) is not merged. Once it is, give the `cartesia-ink2` entry in `configs.ts` a `create`.                                                             |

Before a full pass, run a smoke test with `--limit 2` (the first two regions of each call). After each run, `record` appends the audio it streamed to `packages/eval/corpus/stt-runs/spend.jsonl`. It refuses to start a run that would take the total past `--budget-min` (60 by default).

## Spend

Live audio streamed in this wave was 52.4 minutes in total (ledger: `packages/eval/corpus/stt-runs/spend.jsonl`), under the 60-minute budget. The ledger counts audio frames sent. AssemblyAI streaming bills the session's open time instead, which is longer; the cost figures in the results use that (`billedSeconds` in the score output).

- 8 streaming configurations over both calls, about 4.6 minutes each: 3.4 for the main pass, 0.9 for the near-silent regions, and 0.3 to re-stream 4 regions after a lead-in fix;
- a 2-region smoke test (0.3), a first scribe-auto pass that died on the throttling defect (2.1), and a 5 s probe of that defect;
- a first AssemblyAI pass redone after the commit points were corrected (5.6);
- 2 batch passes, 3.3 minutes each.

At list prices this is about $0.30. No new runtime dependency was added.

## Files

- `packages/eval/src/stt/`: the runner and its parts (`cli.ts` for status, draft, record, batch, candidates and score), with tests in `tests/`.
- `packages/eval/corpus/gold/`: the gold files.
- `packages/eval/corpus/stt-runs/<config>/<call>.json`: every recorded run, with each partial and final and its timing, the commits, and the languages the provider reported. They are scored offline with no keys.
