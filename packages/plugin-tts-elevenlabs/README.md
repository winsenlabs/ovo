# @winsendotai/ovo-plugin-tts-elevenlabs

The `tts` slot over ElevenLabs (TTS-1, TTS-2). Plugin id `@winsendotai/ovo-tts-elevenlabs`, provider
`elevenlabs`. It provides `Cap.tts` (`ovo.tts-streaming@2`) with the incremental `open()` path, so
the speech output, the speech cache and (from Wave 4) `speakStream` all use the same socket.

Defaults, as decided on 2026-10-06: model `eleven_flash_v2_5`, voice Monika Sogam
(`ZUrEGyu8GFMwnHbvLhv2`), μ-law 8 kHz output for Twilio (no resample, no transcode), voice settings
from the collections POC (`stability` 0.5, `similarity_boost` 0.8, `speed` 1). OpenAI TTS stays
installed and selectable as the fallback binding.

## How it talks to ElevenLabs

- **One pooled socket per session.** `wss://api.elevenlabs.io/v1/text-to-speech/{voice}/multi-stream-input`,
  authenticated with the `xi-api-key` header. The plugin is session-scoped, so one instance is one
  call. The socket opens on the first utterance (or on `warm()`), and each utterance is a
  `context_id` (`ovo-1`, `ovo-2`, …) on it. `voice`, `model_id`, `output_format`,
  `language_code`, `seed`, `apply_text_normalization` and `auto_mode` are URL parameters, so a
  different voice or format gets its own pooled socket. `inactivity_timeout` defaults to the
  maximum, 180 s.
- **Per context.** The first text frame carries `voice_settings`, `generation_config` and
  `pronunciation_dictionary_locators`. `push(text)` sends `{text, context_id}`. `flush()` ends the
  input: `{context_id, text: "", flush: true}` then `{context_id, close_context: true}`. The
  context's audio ends at `isFinal`; `is_final` is accepted too, because the cookbook spells it that
  way.
- **Barge-in.** Aborting the input signal, or calling `close()` before `isFinal`, sends
  `close_context` for that context only. Audio still in flight for it is dropped, and the socket
  and the other contexts carry on.
- **Five contexts per socket.** A sixth concurrent `open()` waits, first in first out, for a free
  slot.
- **Reconnect.** When the provider closes the socket (idle timeout, error), the next `open()`
  opens a new one.
- **HTTP fallback.** If the socket cannot open (refused, or no handshake within `connectTimeoutMs`,
  default 3 s), utterances stream from `POST /v1/text-to-speech/{voice}/stream?output_format=…`.
  For 30 s after that, utterances go straight to HTTP and do not wait on the socket again. A
  `synthesize()` whose socket drops before the first byte is retried once over HTTP. HTTP retries
  429, 409 and 5xx twice (250 ms, then 500 ms), and only before the first byte. `transport: 'http'`
  never opens a socket; `httpFallback: false` surfaces the socket failure instead of falling back.
  A policy close (1008: bad key, quota, unknown voice) is not retried.

## Cache identity (TTS-13, plugin side)

`cacheIdentity(format, voice)` returns:

- `model`;
- the resolved voice id;
- a revision `elevenlabs-<encoding>-<rate>-v1-<sha256/16>`, hashed over every binding field that
  changes the audio: voice settings, `languageCode`, `applyTextNormalization`, `seed`, the
  pronunciation dictionaries, `autoMode` and `chunkLengthSchedule`.

Defaults are resolved before hashing, so `{}` and an explicit `stability: 0.5` share clips.
Transport, region, timeouts and logging do not change the audio and are left out. The conformance
kit's `identityVariants` check proves each audio field re-keys the clip.

## Metering and price card (TTS-3)

- **Meter:** `elevenlabs.streaming-tts.characters` (unit `characters`, role `tts`). This is the key
  `meterKey()` derives, and a release needs an effective price card under it.
- **List price:** USD 0.05 per 1,000 characters (Flash v2.5). This is the figure the POC used
  (`PRICE_TTS_USD_PER_1K_CHARS`). **Confirm it against the account's plan before relying on it.**
  Card seeding and the `speech-prerender` cost category belong to OPS-13.
- **Socket usage:** each context emits one meter, at `isFinal`, close or failure, with
  `state: 'estimated'`. The characters counted are the ones the plugin sent. The socket reports no
  billed count.
- **HTTP usage:** the meter uses the `request-id` header as its request id and `character-cost`
  as a `reconciled` quantity, but only when those headers are present. `x-character-count`, the
  name some SDK guides use, is read when `character-cost` is absent. `request-id` and `character-cost` come from the
  API reference introduction (<https://elevenlabs.io/docs/api-reference/introduction>, retrieved
  2026-10-06); the stream reference documents no response headers, so they stay **UNCONFIRMED**
  until a live call. The live smoke test logs the meters so a real call can settle this.
- **Request ids:** without a header, the request id is `elevenlabs:<sessionId>:<n>`. `n` counts
  the instance's utterances and does not reset on reconnect.

## Binding

| Field                                                                                  | Default                               | Notes                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model`                                                                                | `eleven_flash_v2_5`                   | `eleven_turbo_v2_5`, `eleven_multilingual_v2` (10k-character limit).                                               |
| `voiceId`                                                                              | `ZUrEGyu8GFMwnHbvLhv2`                | An agent-level voice override, when one is set, takes precedence.                                                  |
| `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`                    | 0.5, 0.8, unset, 1, unset             | Ranges: 0–1, except `speed`, which is 0.7–1.2.                                                                     |
| `languageCode`                                                                         | unset                                 | ISO 639-1 (`hi`, `ta`). When unset, the model infers the language.                                                 |
| `applyTextNormalization`                                                               | unset (`auto`)                        | Normalization of Indian amounts and dates should come from OVO's own text filter, which runs before the cache key. |
| `pronunciationDictionaries`                                                            | none                                  | Up to 3 `{id, versionId?}` locators, for lender and product names.                                                 |
| `autoMode`, `chunkLengthSchedule`                                                      | `true`, unset                         |                                                                                                                    |
| `region`                                                                               | `global`                              | Also `us`, `eu-residency`, `in-residency`, `sg-residency`. All five hosts are in `egressHosts`.                    |
| `transport`, `httpFallback`, `connectTimeoutMs`, `inactivityTimeoutS`, `enableLogging` | `websocket`, `true`, 3000, 180, unset |                                                                                                                    |

The API key is the binding credential. Create it in the console as a credential with provider
`elevenlabs`; the plugin never reads it from the environment.

## Wire sources (retrieved 2026-10-06)

- **Socket schema:** <https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input>
  - query parameters, `xi-api-key`, message shapes, `isFinal`, regional hosts.
- **Multi-context guide:** <https://elevenlabs.io/docs/developers/guides/cookbooks/multi-context-web-socket>
  - flush, `close_context`, five contexts, 20 s default timeout, interruption.
- **HTTP stream:** <https://elevenlabs.io/docs/api-reference/text-to-speech/stream>
  - body fields, `output_format` values, 422.
- **API introduction:** <https://elevenlabs.io/docs/api-reference/introduction>
  - the `request-id` and `character-cost` response headers.
- **LiveKit's production plugin:** <https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-elevenlabs/livekit/plugins/elevenlabs/tts.py>
  - the end-of-input sequence (`text: ""` + `flush`, then `close_context`, then wait for `isFinal`).
  - `contextId` / `context_id`.

**UNCONFIRMED until a live call:**

- that a context's first frame may carry real text together with `voice_settings` and the dictionary
  locators;
- the shape of error frames (`{error, message, contextId?}` is assumed);
- the HTTP `request-id` and `character-cost` headers (documented, not yet seen on a live call);
- the `{detail: {status}}` error body.

## Tests

- **`tests/conformance.test.ts`:** the TTS kit, including the incremental checks (pushes split in
  two, close after a dropped socket) and the cache-identity variants.
- **`tests/socket.test.ts`:** URL, first-frame fields, pooling, interleaving, barge-in, reconnect,
  context errors, the five-slot limit, dispose and warm.
- **`tests/fallback.test.ts`:** refused and timed-out sockets, the HTTP retry rules, PCM sample
  alignment and HTTP-only metering.
- **`tests/plugin.test.ts`:** the manifest, binding validation and composition with a credential
  reference; the socket closes on session dispose.
- **`tests/live.test.ts`:** a smoke test that runs only with `OVO_LIVE_ELEVENLABS_API_KEY`
  (optionally `OVO_LIVE_ELEVENLABS_VOICE_ID`).
