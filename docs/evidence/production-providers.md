# Production provider adapters

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

## External gates

No Deepgram/OpenAI credential or paid request was used. Provider staging verification, voice quality
measurement, rate-limit behavior, invoice reconciliation, and long-call soak testing remain external
release gates. The local TLS/WSS protocol tests prove adapter behavior, not provider certification.
