# @winsendotai/ovo-plugin-tts-cartesia

The `tts` slot over Cartesia Sonic 3.6. Plugin id `@winsendotai/ovo-tts-cartesia`, provider
`cartesia`. It provides `Cap.tts` (`ovo.tts-streaming@2`) with `synthesize`, the incremental
`open()` path, `openReply()` (LAT-5) and `warm()`. Conformance: `tts@1`, every check, in all four
native formats. Wire facts were read from the official docs on 2026-10-13; the URLs are in
`src/binding.ts`, `src/testing.ts` and below.

## Binding

| Field                           | Default                | Notes                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                         | `sonic-3.6-2026-08-27` | or `sonic-3.6`. The dated snapshot keeps cached clips stable when the alias moves. `sonic-2`, `sonic-turbo` and `sonic-3-2025-10-27` sunset on 2026-10-20; `sonic-latest` now aliases the beta `sonic-preview`. None is selectable ([older models](https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models.md)). |
| `voiceId`                       | required               | A Sonic 3.6 voice id. An agent voice overrides it per utterance.                                                                                                                                                                                                                                                              |
| `language`                      | session language       | The request `language`, case-insensitive, `en_IN` accepted, a missing locale falls back to its base code. Hinglish: `hi` with `normalization: en-IN`.                                                                                                                                                                         |
| `normalization`                 | provider `auto`        | `auto`, `off` or a language/locale (`en-IN` reads digits and dates the Indian way).                                                                                                                                                                                                                                           |
| `accent`, `pronunciationDictId` | none                   | Sent as `accent` and `pronunciation_dict_id`.                                                                                                                                                                                                                                                                                 |
| `speed`, `volume`, `emotion`    | provider defaults      | `generation_config` (0.6–1.5, 0.5–2.0, `neutral\|calm\|angry\|content\|sad`).                                                                                                                                                                                                                                                 |
| `maxBufferDelayMs`              | `0`                    | 0 is the documented custom buffering: OVO sends whole clauses, so Sonic renders at once ([buffering](https://docs.cartesia.ai/use-the-api/tts-websocket/buffering.md)).                                                                                                                                                       |
| `maxContexts`                   | `3`                    | Contexts one call may hold at once (Pro 3, Startup 5, Scale 15 account-wide).                                                                                                                                                                                                                                                 |
| `connectTimeoutMs`              | `3000`                 |                                                                                                                                                                                                                                                                                                                               |
| `apiVersion`                    | `2026-08-14`           | The only accepted value; sent as `cartesia_version`.                                                                                                                                                                                                                                                                          |

The API key is the binding credential (`sk_car_…`), resolved with `ctx.secret('')` (or the nested
`/credentialRef`); never an env var.

## How it talks to Cartesia

- **One pooled socket per call**: `wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14`
  with the `X-API-Key` header. Voice and format travel in each request, so one socket serves every
  format. `warm()` opens it ahead of the first utterance and never rejects. The provider closes
  idle sockets after 5 minutes; the next utterance reopens one lazily.
- **One utterance = one context** (`ovo-1`, `ovo-2`, …). `push(text)` sends the generation request
  with `continue: true`; `flush()` sends `{transcript: "", continue: false}`; the audio ends at
  `done` ([contexts](https://docs.cartesia.ai/use-the-api/tts-websocket/contexts.md)). Every frame of
  a context repeats the same fields, as the reference requires.
- **Replies (LAT-5)**: one context per reply. Each `segment()` sends its words with a trailing
  space (transcripts are concatenated verbatim), then `{transcript: "", continue: true,
flush: true}`. A segment's audio is every chunk until the matching `flush_done`, which the
  in-order guarantee makes exact ([flushing](https://docs.cartesia.ai/use-the-api/tts-websocket/context-flushing-and-flush-i-ds.md)).
  Contexts expire 1 s after their last audio, so after more than 800 ms of quiet (a tool call, a
  guard hold) the next segment opens a fresh context id (`ovo-1-2`, …).
- **Barge-in**: `close()` (or an aborted signal) sends `{context_id, cancel: true}` and drops every
  later chunk for that context locally, because cancel "will only halt requests that have not begun
  generating".
- **Retries**: a retryable refusal (429 `concurrency_limited`, 5xx, a dropped socket or a refused
  handshake) before the first audio replays the text on a fresh context id after 250 ms, then
  750 ms. After audio has been heard a retry would repeat words, so the failure surfaces. Quota,
  voice, model and language errors are final.
- **Concurrency**: a per-call semaphore holds at most `maxContexts` live contexts; waiters are served
  first come, first served, and an aborted waiter leaves the queue.
- **PCM16** chunks split on an odd byte are re-cut into whole samples; a stream that ends mid-sample
  fails.

## Cache identity

`cacheIdentity(format, voice)` = `{provider: 'cartesia', model, voice, revision}` with revision
`cartesia-v1-<sha256/16>` over model, voice, language, normalization, accent, `generation_config`,
pronunciation dictionary and output format, defaults resolved first. Buffering, slots and timeouts
stay out. The kit's `identityVariants` check proves each audio field re-keys the clip.

## Metering and pricing

- Meter `cartesia.streaming-tts.characters` (unit `characters`, role `tts`), one per context (one
  per segment for replies, `<requestId>/<n>`), `state: 'estimated'`: the code points sent. Sonic
  returns no billed count. A context refused before any audio is metered at 0, since "credits are
  only used by successful requests".
- **Pricing is per plan tier.** Sonic bills about 1 credit per character
  ([pricing](https://docs.cartesia.ai/pricing.md)); USD per credit depends on the plan: overage
  $65 (Pro), $45 (Startup), $38 (Scale) per 1M credits ([cartesia.ai/pricing](https://cartesia.ai/pricing)).
  The price cards (wiring lane, design section 13) are **provisional**, derived at Scale overage:
  USD 0.038 per 1,000 characters for both `sonic-3.6-2026-08-27` and `sonic-3.6`. Re-price when the
  founder picks a plan.

## UNCONFIRMED (settle with `tests/live.test.ts` and a real key)

1. Whether `Authorization: Bearer` is accepted on the WebSocket handshake (`X-API-Key` is used).
2. Whether `chunk` events carry `flush_id` (the guide says so, the schema does not). Segments are
   routed by order and `flush_done`, not by id.
3. What the server returns when a request reaches an expired context, and whether a cancelled
   context still sends `done` (the plugin waits on neither).
4. The per-context character limit on the socket; `maxChars` is a conservative 5000.
5. The `status_code` of `quota_exceeded` (fixtures assume 402; the plugin judges by `error_code`).
6. The `generation_config` ranges (taken from a summary of the reference; spot-check).
7. Official Hindi / Indian English voice ids (docs name Shreeraj and Kriti without ids).
8. Real time to first audio from GCP asia-south1; India regional endpoints are Enterprise-only.

## Live smoke test

`OVO_LIVE_CARTESIA_API_KEY=sk_car_… [OVO_LIVE_CARTESIA_VOICE_ID=…] pnpm vitest run packages/plugin-tts-cartesia/tests/live.test.ts`
logs warm time, TTFA and bytes per utterance, and a two-segment reply. Skipped without the key.
