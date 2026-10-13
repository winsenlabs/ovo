# Production provider adapters

## I1 integration update (2026-10-02)

The selected Deepgram, AssemblyAI and Sarvam STT plugins and OpenAI/Sarvam TTS plugins each execute through the real distribution/session graph in 48 fixture-matrix rows across native and LiveKit engines. All selected STT rows report `sttMode: template`, rather than a generic fallback, and usage is estimated and unpriced. The installed LiveKit Darwin binding runs these rows on macOS; the glibc-only declaration was over-restrictive and has been removed. No vendor endpoint was contacted and no provider credential value was read by fixture calls. Inference uses a fixture plugin, and the confirmed write uses a fixture handler.

## Implemented profile

- Deepgram `/v1/listen` realtime STT over an authenticated WebSocket.
- OpenAI `/v1/audio/speech` streaming TTS using the documented raw 24 kHz, signed 16-bit,
  little-endian PCM response.
- OpenAI `/v1/audio/transcriptions` as an explicit **batch-only** alternate STT capability.
- OpenAI AI SDK model creation through `@ai-sdk/openai` 4.0.71, compatible with the repository's
  AI SDK 7 provider interfaces.
- Static speech-cache and live media bridges share the existing bounded speech scheduler. The live
  bridge is the voice package's mark-aware `StreamingMediaSpeechOutput`; the static bridge collects
  a bounded TTS stream for the existing exact-byte cache port.

All production endpoints are fixed to the official provider hosts. Endpoint injection and private
TLS trust are constructor-only test dependencies and are not plugin configuration. Credentials are
opaque binding references resolved server-side through `SecretResolver`; raw secrets are not in
plugin config, binding snapshots, errors, or telemetry.

## Protocol behavior

### Deepgram realtime STT

- Sends 8 kHz G.711 mu-law audio as binary frames with bounded input chunks, bounded WebSocket
  buffered bytes, and a bounded inbound WebSocket message size.
- Emits monotonic partial/final revisions with endpoint flags, confidence only when supplied, and
  start/duration timing. The first non-empty hypothesis for each utterance carries `speechStarted`
  so the shared session engine can apply its barge-in policy.
- Sends `KeepAlive` during pauses and `CloseStream` for graceful completion.
- Applies connect, finish, and maximum-session deadlines and links caller cancellation.
- Retries only the initial connection before `start()` returns. After any caller audio can exist,
  disconnect is terminal: the adapter never blindly replays audio into a new recognition session.
- Emits provider audio seconds when supplied. Missing duration emits an explicit unavailable usage
  record with no quantity; it is never converted to zero.

### OpenAI streaming TTS

- Requests raw PCM and reads the response incrementally with a total byte cap.
- Preserves PCM sample framing across arbitrary HTTP chunks.
- Converts 24 kHz PCM to 8 kHz with an explicit 3:1 box-filter downsample, then applies standard
  G.711 mu-law encoding. Output chunks are independently bounded.
- The static bridge can also retain 24 kHz signed PCM. Unsupported codec/rate combinations fail
  explicitly rather than being mislabeled.
- Character usage is recorded as estimated because the speech response does not include reconciled
  usage. Provider request IDs remain optional.

### OpenAI batch transcription

- Wraps raw mono PCM or G.711 mu-law in the corresponding WAVE format and submits multipart audio.
- Enforces request/response byte limits, deadlines, cancellation, bounded JSON parsing, and no
  retries.
- Registers only `ovo.stt-batch`, never the realtime `ovo.stt` capability.
- Provider usage is reconciled when returned; omitted usage remains unavailable without a zero.

## Composition API

- `deepgramBindingFromRecord` + `createDeepgramSttPlugin` provide `ovo.stt`.
- `openAiTtsBindingFromRecord` + `createOpenAiTtsPlugin` provide `ovo.tts-streaming` and `ovo.tts`.
- `openAiBatchSttBindingFromRecord` + `createOpenAiBatchSttPlugin` provide `ovo.stt-batch` only.
- `openAiInferenceBindingFromRecord` + `createOpenAiInferenceProviderPlugin` provide
  `ovo.inference` and require `ovo.secret-resolver`.
- `createOpenAiModelFactory` exposes the same immutable, secret-backed model factory directly.
- `OPENAI_INFERENCE_PLUGIN_CONFIG_SCHEMA` is the runtime config schema for instructions/output
  bounds; provider model and credentials remain in the immutable binding closure.

## Verification

Local tests use a real TLS server and real WebSocket client/server protocol exchange. They cover:

- authenticated Deepgram query/frame behavior, partial/final timing and confidence, graceful close,
  connect-only retry with exactly one audio frame, malformed frames, bounds, and cancellation;
- chunked odd-boundary OpenAI PCM, exact downsample/mu-law output, output chunk bounds, cache bridge,
  multipart batch WAVE, missing usage, malformed JSON, redacted provider errors, response limits,
  and cancellation;
- immutable binding snapshots during asynchronous secret resolution, strict stored-binding parsing,
  AI SDK model construction, and Cordis plugin composition.

Focused result: 3 files and 11 tests passed. No paid provider request was made.

## Official references reviewed on 2026-09-20

- Deepgram streaming API: https://developers.deepgram.com/reference/speech-to-text/listen-streaming
- Deepgram lower-level WebSockets: https://developers.deepgram.com/docs/lower-level-websockets
- Deepgram keepalive guidance: https://developers.deepgram.com/docs/audio-keep-alive
- Deepgram connection recovery: https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio
- OpenAI text-to-speech guide: https://developers.openai.com/api/docs/guides/text-to-speech
- OpenAI transcription API: https://platform.openai.com/docs/api-reference/audio/createTranscription
- AI SDK OpenAI provider: https://ai-sdk.dev/providers/ai-sdk-providers/openai

## Wave 11: Cartesia and Rumik (2026-10-13)

Three packages, four plugin definitions, all installed by the distribution for the session role
and offline-tested only: no Cartesia or Rumik endpoint was contacted and no key was read. Live
tests exist and skip without `OVO_LIVE_CARTESIA_API_KEY` / `OVO_LIVE_RUMIK_API_KEY`. Vendor keys
are binding credentials resolved with `ctx.secret('')`, never env. Each package README lists its
UNCONFIRMED items; the price cards follow the Wave 11 design, section 13.

| Plugin id                              | Provider          | Slot | Endpoint                                                                       | Formats                                              |
| -------------------------------------- | ----------------- | ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `@winsendotai/ovo-tts-cartesia`        | `cartesia`        | tts  | `wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14`, `X-API-Key` | μ-law 8 kHz, PCM16 8/16/24 kHz (native)              |
| `@winsendotai/ovo-stt-cartesia`        | `cartesia`        | stt  | `/stt/turns/websocket` (Auto: Cartesia ends turns), ink-2                      | μ-law 8 kHz, PCM16 8/16 kHz                          |
| `@winsendotai/ovo-stt-cartesia-manual` | `cartesia-manual` | stt  | `/stt/websocket` (Manual: host `finalize`), ink-2 or ink-whisper               | μ-law 8 kHz, PCM16 8/16 kHz                          |
| `@winsendotai/ovo-tts-rumik`           | `rumik`           | tts  | `POST https://silk-api.rumik.ai/v1/tts/ws-connect`, then the minted `wss://`   | μ-law 8 kHz, PCM16 24 kHz (Silk has no 8/16 kHz PCM) |

- **Cartesia Sonic TTS.** Model `sonic-3.6-2026-08-27` (default, a dated snapshot so cached clips
  stay stable) or `sonic-3.6`; sonic-2 and sonic-turbo sunset on 2026-10-20 and are not
  selectable. One pooled socket per session, one context per utterance; barge-in sends `cancel`
  and also drops that context's late chunks, because Cartesia keeps sending a generation already
  in progress. Usage `cartesia.streaming-tts.characters`, estimated.
- **Cartesia Ink STT.** Two definitions because the runtime installs one STT definition per
  provider; the Manual one is `cartesia-manual` and needs the same key stored under that provider.
  ink-2 transcribes en/fr/hi/ja/es with its own detection; ink-whisper (Manual only) needs a pinned
  `language` and covers the Indic languages. A silence keeper writes codec silence when the host
  writes nothing for 200 ms (Cartesia needs a continuous stream and bills silence anyway) and the
  pre-session backlog is paced at most 2× real time. Usage `*.streaming-stt.audio_seconds`.
- **Rumik Silk TTS.** TTS only: Rumik publishes no speech-to-text API, so there is no Rumik STT
  plugin. Models `mulberry` (default; `description` required, at most 300 characters, billed per
  request) and `muga` (`[tone]` prefix). Silk renders one generation per socket and a new `text`
  frame interrupts the running one, so lines and reply segments go through a per-session FIFO;
  barge-in sends `cancel`. The plugin refuses a minted `ws_url` outside `wss://silk-api.rumik.ai/`.
  HTTP fallback `POST /v1/tts` retries only before the first byte (502 once, 503 twice); a
  connection that fails before any response is not repeated because it may already be billed.
  Known risk: every segment pays Rumik's per-request time to first byte. Usage
  `rumik.streaming-tts.characters` (text plus mulberry description), estimated.
- **Price cards** (`packages/plugin-ledger/catalog/vendor-prices.json`, all `provisional`):
  Cartesia in USD at the Scale overage rate, $38 per 1M credits (TTS 1 credit per character,
  ink-2 3 credits/s, ink-whisper 1 credit/s; ink-2 is carded under both STT providers); Rumik in
  INR at pay-as-you-go list prices, Mulberry 1.5 ₹0.50 and Muga ₹0.99 per 1K characters. Re-price
  when the founder picks the plans.

Verification (mini, 2026-10-13): `vitest run packages/plugin-tts-cartesia` 43 passed, 2 skipped
(live); `packages/plugin-stt-cartesia` 54 passed, 3 skipped (live); `packages/plugin-tts-rumik` 66
passed, 2 skipped (live). Each runs its kit's conformance (`tts@1` / `stt@1`) over fixture scripts
transcribed from the vendor docs, each script carrying its source URL and retrieval date.
`packages/distribution/tests/speech-catalog-w11.test.ts` loads all four from the production
catalog and composes each over its fixtures.

Official references (retrieved 2026-10-13): https://docs.cartesia.ai/api-reference/tts/websocket.md,
https://docs.cartesia.ai/api-reference/stt/turns/websocket.md,
https://docs.cartesia.ai/api-reference/stt/websocket.md,
https://docs.cartesia.ai/use-the-api/tts-websocket/contexts.md,
https://docs.cartesia.ai/build-with-cartesia/stt/audio-input.md,
https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models.md,
https://docs.cartesia.ai/pricing.md, https://cartesia.ai/pricing, https://docs.rumik.ai/openapi.json,
https://docs.rumik.ai/streaming, https://docs.rumik.ai/audio-formats, https://docs.rumik.ai/muga,
https://docs.rumik.ai/agent-limits, https://docs.rumik.ai/pricing/pay-as-you-go,
https://docs.rumik.ai/cookbook/voice-agent-pipecat.

External gates: a live key per vendor, TTFA/TTFS from asia-south1, Indian English and Hinglish
accuracy at 8 kHz (Cartesia), Rumik's segment-gap latency (LAT-5), the plan tiers behind the price
cards, and the UNCONFIRMED items in each README.

## External gates

No Deepgram/OpenAI credential or paid request was used. Provider staging verification, voice quality
measurement, rate-limit behavior, invoice reconciliation, and long-call soak testing remain external
release gates. The local TLS/WSS protocol tests prove adapter behavior, not provider certification.
