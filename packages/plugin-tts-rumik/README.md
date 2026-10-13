# @winsendotai/ovo-plugin-tts-rumik

The `tts` slot over Rumik Silk. Plugin id `@winsendotai/ovo-tts-rumik`, provider `rumik`. It
provides `Cap.tts` (`ovo.tts-streaming@2`) with `synthesize`, `openReply` and `warm`, and no
`open()`: Silk cannot take text incrementally.

Rumik has **no speech-to-text API** (the OpenAPI spec has no transcription path, and Rumik's own
cookbooks use Deepgram for STT), so there is no `plugin-stt-rumik`.

Every vendor fact below was read from https://docs.rumik.ai on 2026-10-13. The sources are in
`src/testing.ts`, next to the fixtures transcribed from them.

## How it talks to Rumik

- **Auth.** `Authorization: Bearer rk_live_…`, read through `ctx.secret('')` and never from env.
  The key needs the `tts` and streaming scopes. It is sent only to `POST` endpoints. The socket
  carries a single-use token instead.
- **Mint, then connect.** `POST https://silk-api.rumik.ai/v1/tts/ws-connect` with
  `{model, text: "init", audio_format}` returns `{ws_url, token, request_id, expires_in: 300}`.
  The plugin connects to `ws_url?token=…`. It refuses any `ws_url` that is not
  `wss://silk-api.rumik.ai/…` (other host, port, credentials or scheme), so a bad mint answer cannot
  redirect the audio or the token. The model and `audio_format` are fixed per socket at mint time.
- **Formats.** `mulaw` (raw 8 kHz G.711 μ-law, which Twilio takes as is) and `pcm` (raw 24 kHz
  s16le). Silk has no 8 kHz or 16 kHz PCM, so the plugin advertises only `MULAW_8K` and
  `PCM16_24K`. The host resamples anything else. PCM chunks are re-cut into whole samples.
- **Socket lifecycle.** The socket opens on `warm()` or on the first line. Any close, any
  `{"type":"timeout"}` and any fatal error frame retire it, and the next line mints a new one.
  A token that is already within 5 s of expiry when the mint returns is minted again. The expiry
  runs from when the mint request was sent. `dispose()` (session end) sends `{"type":"close"}`.
- **One generation at a time (R3).** A second `{"text"}` frame interrupts the first
  ("latest-wins"), so `synthesize` calls and reply segments wait in a per-session FIFO. Each line
  is sent only after the previous line's `done`, `cancelled` or error frame. Audio is buffered as
  it arrives, so the next line does not wait for the speaker to read the current one.
- **Abort and barge-in.** Aborting a running line sends `{"type":"cancel"}` and ends its audio
  immediately. Chunks that arrive after that are dropped until `cancelled` or `done`, and only then
  does the next line go out. If no acknowledgement arrives within 2 s, the plugin gives up the
  socket and the queue goes on with a fresh one. A line aborted while queued never reaches Rumik
  and is not metered.
- **Errors on the socket.** `{"error": true, "code", "recoverable"}`: `INVALID_TEXT` and
  `INVALID_MESSAGE` fail that line only. They are recoverable, and the socket takes the next line.
  `INVALID_TEXT` is metered as 0 characters because Rumik does not charge it. Any other code
  retires the socket.

## Replies (R4) and the latency risk

`openReply` gives each segment (sentence) its own generation on the same queue. Segment N+1 is
sent only after segment N's `done`. `close()` (barge-in, or the reply went idle) ends every
unfinished segment at once and quietly: queued segments never reach Rumik, and the running one is
cancelled. The socket outlives the reply.

**Known risk, not fixable in the plugin.** Every segment pays Rumik's per-request time to first
byte, and a segment cannot start until the previous one is `done`. This can leave an audible gap
between sentences. Rumik's own Pipecat plugin buffers the whole LLM response into one request "to
avoid audible gaps caused by Rumik's current per-request TTFB"
(https://github.com/ira-rumik/pipecat-rumik, `_FullResponseTextAggregator`). That trades the gaps
for a later first word. Mulberry's "162 ms" is a marketing figure, and nobody has measured muga's
TTFB. LAT-5 has to choose between the two with a live A/B from asia-south1. `tests/live.test.ts`
logs the time to first byte per line.

## HTTP fallback (R5)

`POST https://silk-api.rumik.ai/v1/tts` with `audio_format`, read as a binary stream. It is the
whole path when the binding sets `transport: 'http'`. It is also the fallback when the socket
cannot be minted or connected (within `connectTimeoutMs`, default 3 s), or drops before the
line's first byte. After a failed mint or connect, lines go straight to HTTP for 30 s.
`httpFallback: false` surfaces the socket failure instead.

All retries happen before the first byte. The rules:

| Response                                             | Handling                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `502 GENERATION_ERROR`                               | Retried once, immediately. Rumik calls it "safe to retry once" and does not charge it.                                                   |
| `503`                                                | Retried after 250 ms, then after 500 ms.                                                                                                 |
| `429` (`concurrency_limit_exceeded`, `rate_limited`) | Not retried. Thrown as a retryable `RumikTtsError` with its code and `retryAfterMs` (from `Retry-After`, which only rate limiting sets). |
| `402` (`insufficient_balance`, `access_blocked`)     | Not retryable.                                                                                                                           |
| `401`, `403`, `400`, `422`                           | Not retryable. The socket path does not fall back to HTTP for these either, because HTTP would refuse the same way.                      |

`X-Usage-Cost-Nanos` (the pay-as-you-go charge, in nano units of the account currency, 0 on
unlimited plans) and `X-Audio-Duration-Ms` are logged as `rumik.tts.http`. They are never used as a
character count. Error messages from Rumik are dropped and only the `code` is kept, because the
`422` message can quote request fields.

## Binding

| Field                                                              | Notes                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                                            | `mulberry` (default) or `muga`.                                                                                                                                                                                                        |
| `speaker`                                                          | mulberry only. One of `emma mia sophia ava ira siya aisha zoya lucas noah theo adam`. A request `voice` overrides it. An unknown voice name is not sent, because Rumik silently turns unknown names into a described voice.            |
| `description`                                                      | **Required for mulberry**, capped at 300 characters. Rumik builds the voice from it and bills its characters on every request (on the pricing page, a 7-character text with a 491-character description bills 498). Not sent for muga. |
| `defaultTone`                                                      | muga only. `neutral` (default), `happy`, `excited`, `sad`, `angry` or `whisper`.                                                                                                                                                       |
| `temperature`, `topP`, `topK`, `repetitionPenalty`, `maxNewTokens` | Sent only when set; Rumik's defaults are 0.6, 0.95, 50, 1.2 and 2048. For muga, Rumik recommends a temperature of 0.7. The bounds are OVO's choice, since Rumik documents none.                                                        |
| `normalization`                                                    | Default **false**. OVO's speech normaliser already writes replies for the ear, and running both would read some figures twice. The founder may switch to Rumik's normaliser, which handles lakh/crore and quoted IDs.                  |
| `transport`, `httpFallback`, `connectTimeoutMs`                    | See above.                                                                                                                                                                                                                             |

`maxChars` is 2000 for mulberry and 1990 for muga, which leaves room for the `[tone] ` prefix
under Rumik's 2000-character limit.

## muga tone tags (R6)

muga text "must start with a `[tone]`". If a line does not lead with one of the six lowercase
tags, the plugin prefixes `[defaultTone] `. Everything else is sent as written: inline events
(`<laugh>`, `<chuckle>`, `<sigh>`), later tags and paragraph breaks. mulberry text is never touched.

What OVO's text filters do today (the report in `tests/muga.test.ts`):

- Tags and events pass every filter unchanged.
- The markdown filter drops bracketed numbers such as `[2]` as citations.
- Indian verbalisation rewrites figures around the tags.

One gap remains for W12, outside this lane: OVO splits a reply into sentences before TTS, so only
the first sentence keeps an LLM-written leading `[tone]`. Later sentences get `defaultTone`.

## Cache identity

`cacheIdentity(format, voice)` returns:

- `provider: 'rumik'`;
- the model;
- the voice: the request voice, else `speaker`, else `described` for mulberry or `muga`;
- a revision `rumik-<encoding>-<rate>-v1-<sha256/16>` over speaker, description, defaultTone, the
  sampling fields and normalization.

Defaults are resolved before hashing. Transport, fallback and timeouts are left out.

Sampling is stochastic, so a cached clip is one sample of the voice.

## Metering and price cards

- **Meter:** `rumik.streaming-tts.characters` (unit `characters`, role `tts`, the `meterKey()`
  convention). There is one estimated meter per billed line, with a synthetic request id
  `rumik:<session>:<n>`. The quantity is the characters as sent (tone prefix included) plus the
  description on mulberry. Rumik's own `request_id` is not used, because whether it is
  per-generation or per-socket is unconfirmed.
- **Price cards (provisional; the wiring lane adds them):** mulberry ₹0.50 per 1,000 characters,
  muga ₹0.99 per 1,000 (https://docs.rumik.ai/pricing/pay-as-you-go). Unlimited plans bill usage
  at zero and sell concurrency instead. The marketing page shows different per-minute prices, which
  are unconfirmed.

## Concurrency

On pay-as-you-go, an account gets **4 concurrent slots in total**, shared by TTS, dashboard
sessions and agents (https://docs.rumik.ai/agent-limits). A full pool answers `429
concurrency_limit_exceeded`. If an idle open socket holds a slot, pay-as-you-go caps OVO at
about 4 concurrent calls. Rumik has not confirmed whether it does.

## Questions for Rumik (api@rumik.ai) before go-live

1. Does an open but idle TTS WebSocket hold a concurrency slot?
2. What are the server idle timeout and the maximum socket lifetime? Does a socket outlive its
   token's 300 s?
3. Are Tamil, Telugu, Bengali, Marathi or other Indic languages available on the API, and on which
   model? The API docs list only English, Hindi and Hinglish, so the plugin advertises only `en`,
   `en-IN`, `hi` and `hi-IN`.
4. Are `normalization` and the sampling fields honoured in socket frames?
5. Is the `ws-connect` mint `text` billed?
6. Is `description` billed on every socket frame?
7. What is the full list of socket error codes, and what are the `queued` and `rtf` frames seen
   in the Pipecat plugin?
8. What are the TTFB p50 and p95 for muga and mulberry from India (asia-south1)?
9. Is the `ws_url` host always `silk-api.rumik.ai`?
10. Is the socket's `request_id` per generation or per session? Is a cancelled generation billed
    in full?
11. Is a standalone streaming STT API available or planned?

## Testing

- `tests/conformance.test.ts`: the `tts@1` kit for both formats, with the reply and warm checks
  and `identityVariants` for every audio field. The incremental checks skip themselves.
- `tests/{binding,socket,queue,reply,http,muga,plugin}.test.ts`: fixture-net unit tests. The
  reply tests include one end-to-end test through the speech scheduler and output.
- `tests/live.test.ts` is skipped unless `OVO_LIVE_RUMIK_API_KEY` is set. It is billed (about
  600 characters). It logs TTFB per line and the HTTP cost header.

The fixture templates assume the default model, with `FIXTURE_BINDING` (the streaming docs'
example description). A host that replays them must bind the plugin with that description.
