# @winsendotai/ovo-plugin-stt-cartesia

Cartesia Ink realtime speech to text, as two plugin definitions with static capabilities. Both
provide `Cap.stt` (`ovo.stt-streaming@2`) and pass `stt@1`. Wire facts were read from the official
docs on 2026-10-13; the URLs are in `src/wire.ts`, `src/testing.ts` and below.

| Plugin id                                       | Endpoint               | Models                             | Turns                                                                                                                           |
| ----------------------------------------------- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@winsendotai/ovo-stt-cartesia` (Auto)          | `/stt/turns/websocket` | `ink-2`                            | Cartesia detects turns: `speech-start`, `end-of-turn` (eager too), `turn-resumed`. `forceEndpoint: false`, no local VAD needed. |
| `@winsendotai/ovo-stt-cartesia-manual` (Manual) | `/stt/websocket`       | `ink-2` (default) or `ink-whisper` | The host ends turns: `forceEndpoint: true`, so a release selects a local VAD, as with Scribe manual commit. Word timestamps.    |

**Two providers.** The Auto definition's provider is `cartesia`, the Manual one's is
`cartesia-manual`. The runtime installs at most one STT definition per provider
(`runtime/src/installed.ts`), because a binding without a plugin id resolves its plugin by
`(kind, provider)`; two `cartesia` STT definitions refuse to load. So an operator binds the Manual
definition under `cartesia-manual` and stores the same Cartesia key as a `cartesia-manual`
credential (the console lists credentials of the binding's provider). The design's single
`cartesia` provider would need a runtime change (W12).

Both connect to `wss://api.cartesia.ai<path>?model=…&encoding=pcm_mulaw|pcm_s16le&sample_rate=8000|16000&cartesia_version=2026-08-14`
with the `X-API-Key` header. Native inputs: μ-law 8 kHz, PCM16 8 and 16 kHz. The API key is the
binding credential (`sk_car_…`), resolved with `ctx.secret('')`; never an env var.

## Languages

- **ink-2** transcribes `en`, `fr`, `hi`, `ja`, `es` and detects among them itself; there is no
  language parameter ([stt/latest](https://docs.cartesia.ai/build-with-cartesia/stt/latest.md)). A
  session in any other language is refused at `start()`.
- **ink-whisper** (Manual only) covers about 100 languages, including Tamil, Telugu, Kannada,
  Malayalam, Marathi, Bengali, Gujarati, Punjabi and Urdu, but does no detection: the binding pins
  `language` (required), and a session in another language is refused rather than heard as the
  pinned one. Keyterms are ink-2 only.
- The Manual definition declares `bindingLanguages` per model, so the host compat check approves
  `ta-IN` only for an ink-whisper binding.

## Auto (`/stt/turns/websocket`)

[Reference](https://docs.cartesia.ai/api-reference/stt/turns/websocket.md),
[turn detection](https://docs.cartesia.ai/use-the-api/stt/turns.md).

- `turn.start` → `speech-start` and a new segment; `turn.update` → an interim (the transcript is
  cumulative within a turn and never revised); `turn.eager_end` → an interim and
  `end-of-turn {eager: true}`; `turn.resume` → `turn-resumed`; `turn.end` → the final and
  `end-of-turn`. A turn that ends with no words ends silently.
- Binding: `endpointing` `fast | balanced | patient` maps to the documented Responsive / Balanced /
  Patient profiles; explicit `turnStartThreshold` (0.5–0.9), `turnEagerEndThreshold` (0.3–0.8),
  `turnEndThreshold` (0.05–0.5), `turnEndTimeoutMs` (640–11200) overlay the preset and must keep
  start > eager end > end. Nothing set sends no `turn_*` parameter (the provider's Balanced).
- `updateConfiguration` sends `{"type":"config","turn":{…}}` for a preset or `maxTurnSilenceMs`
  (clamped to `end_timeout_ms`). Keyterms are connect-time only ("You cannot add or change keyterms
  mid-stream"): a change is logged and ignored. `endOfTurnConfidenceThreshold` is not mapped,
  because Cartesia ends a turn when the likelihood falls _below_ `end_threshold`.
- `finish` sends `{"type":"close"}`; the provider flushes, sends its last events and closes. A turn
  still open at that close is kept as final. A 3 s deadline ends the session if it never closes.

## Manual (`/stt/websocket`)

[Reference](https://docs.cartesia.ai/api-reference/stt/websocket.md).

- `forceEndpoint` queues the bare text frame `finalize` behind the audio written before it, and
  only when caller audio arrived since the last one (keeper silence does not count).
- `is_final` texts are deltas to be concatenated verbatim. OVO joins finals with a space
  (`plugin-voice/src/engine/fallback-turns.ts`), so the deltas of one finalize are held, shown as
  interims, and emitted as **one** final at its `flush_done` (`Insert` + `ing the card.` →
  `Inserting the card.`), with word timestamps in milliseconds and the `language` field when sent.
- `finish` finalizes any unfinalized audio, sends `close` once every `flush_done` is in, and ends at
  `done`. Held words are still delivered if the 3 s deadline passes first. `cancel` drops them.
- ink-whisper's `minVolume` and `maxSilenceDurationSecs` are sent as `min_volume` and
  `max_silence_duration_secs`.

## Continuous audio, the silence keeper and the backlog pacer

**C0, settled from the code (b18b24e):** STT writes are **not** gated during agent playback. The
worker hands every carrier audio frame to the engine (`apps/worker/src/worker-media-server.ts`
`onAudio`); `plugin-voice/src/engine/ingress.ts` admits each one (`accept`, line 170) and drains it
straight into `stt.write` (`drain`, line 187), whether or not the agent is speaking; the optional
`ingress-filter.ts` only denoises; and `session-host/src/speech-adapters/stt-format.ts` only
transcodes and re-frames to `frameMs.preferred`. So during playback Cartesia hears the caller's line
(echo-cancelled by the carrier, or not). Gaps still happen: before the STT connects (the worker
buffers up to 15 s and replays it in one burst), during an STT reconnect (the unfinalized audio is
replayed), and when a carrier stops sending (hold, packet loss).

Both cases are covered in the plugin:

- **Silence keeper.** Ink needs a continuous stream ("your client needs to send silence",
  [audio input](https://docs.cartesia.ai/build-with-cartesia/stt/audio-input.md)). After 200 ms
  without a write the keeper sends the gap as codec-correct silence (μ-law `0xFF`, PCM16 zeros; never
  `0x00` for μ-law, which is full-scale), then 100 ms per tick, at most 1 s after a stalled event
  loop. It stays quiet while paced backlog is still queued.
- **Backlog pacer.** Audio goes out in 100 ms binary frames through a token bucket at most
  `backlogMaxRate` (default 2) times real time with one frame of headroom, because bursts "can
  overload the server-side buffer". Live audio never waits; a 15 s replay drains in about 7.5 s.
  Text commands (`finalize`, `close`) queue behind the audio before them.

## Metering and pricing

- Meters `cartesia.streaming-stt.audio_seconds` (Auto) and
  `cartesia-manual.streaming-stt.audio_seconds` (Manual), unit `audio_seconds`, role `stt`: the
  keys `meterKey()` derives from each definition's provider, which the worker prices against. Once
  per session across finish, cancel and failure, `state: 'estimated'`: bytes sent over the format's
  byte rate, **keeper silence included**, because "Silence is also included"
  ([pricing](https://docs.cartesia.ai/pricing.md)). The request id is the provider's `request_id`,
  else `<provider>:<sessionId>:<n>`.
- **Pricing is per plan tier.** ink-2 bills 3 credits per second, ink-whisper 1 credit per second;
  USD per credit is $65 (Pro), $45 (Startup) or $38 (Scale) per 1M credits overage
  ([cartesia.ai/pricing](https://cartesia.ai/pricing)). The price cards (wiring lane, design
  section 13, split by provider) are **provisional**, derived at Scale overage: `ink-2`
  USD 0.4104/h (one card per provider), `ink-whisper` USD 0.1368/h (`cartesia-manual` only). The
  vendor quotes $0.39/h for ink-2 on Scale. Re-price when the founder picks a plan.

## Failures

`error` events with 429 `concurrency_limited` or 5xx, unexpected closes, refused 429/5xx handshakes
and the connect deadline (`connectTimeoutMs`, default 6000) are retryable `CartesiaSttError`s, which
the host's STT recovery reconnects from. Quota, model, language, format and plan errors, 401/403
handshakes and policy closes are final. Messages carry the code, status and request id, never words.

## UNCONFIRMED (settle with `tests/live.test.ts`, a real key and recorded call audio)

1. Whether `Authorization: Bearer` is accepted on the handshake (`X-API-Key` is used).
2. How much burst Ink tolerates for the pre-session backlog (pacing at 2x is a guess).
3. The Manual endpoint with ink-2: the reference says `language` is ink-whisper only, the
   troubleshooting page asks for `?language=`; whether finals carry `language`.
4. Whether `flush_done` always follows every `is_final` delta its `finalize` produced (the plugin
   joins until `flush_done`).
5. What the turns endpoint sends after `{"type":"close"}` besides the remaining turn events.
6. ink-2 accuracy on 8 kHz μ-law for Indian English and Hinglish, and ink-whisper for ta/te/kn/ml at
   8 kHz (needs an A/B against Scribe on recorded calls).
7. TTFS from GCP asia-south1; India regional endpoints are Enterprise-only.
8. The `status_code` values of fatal errors on the STT sockets (judged by `error_code` first).

## Live smoke test

`OVO_LIVE_CARTESIA_API_KEY=sk_car_… [OVO_LIVE_CARTESIA_STT_AUDIO=call.ulaw] [OVO_LIVE_CARTESIA_STT_LANGUAGE=en-IN] pnpm vitest run packages/plugin-stt-cartesia/tests/live.test.ts`
streams the audio (raw 8 kHz μ-law; 2 s of silence without it) in real time through both
definitions and logs connect time, TTFS, time to final, the finals and the meter. Skipped without
the key.
