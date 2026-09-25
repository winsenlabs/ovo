# Work unit S2-speech-new: New speech providers: AssemblyAI Universal Streaming STT, Sarvam realtime STT and Sarvam Bulbul TTS, with fixture templates

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [21, 9]

## Owned paths

- packages/plugin-stt-assemblyai/**
- packages/plugin-speech-sarvam/**
- scripts/baselines/pending/S2.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: add AssemblyAI Universal Streaming STT, Sarvam realtime STT and Sarvam TTS as selectable plugins, with no shared-code edits. Read docs/architecture/plugin-platform.md (revision 2): sections 2.3–2.4 (native formats only; the host adapts formats and frame sizes) and section 9. Use ctx.net only (no ws or node:https imports), ctx.secret('/credentialRef') for the API key, and the binding config from row config 'binding'. Emit usage exactly once per session, always with a requestId. F3 created the skeletons packages/plugin-stt-assemblyai and packages/plugin-speech-sarvam with catalog entries. Fill them and remove the ovo.skeleton flags.

A. packages/plugin-stt-assemblyai
Sources: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api, https://www.assemblyai.com/docs/streaming/message-sequence, https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures, https://www.assemblyai.com/docs/speech-to-text/universal-streaming.

- v2 plugin: id '@winsendotai/ovo-stt-assemblyai', kind 'stt', provider 'assemblyai', provides ['ovo.stt'].
- bindingSchema {model (default 'universal-streaming-english'; the enum includes 'universal-3-5-pro' and 'universal-streaming-multilingual'), region: 'default' | 'us' | 'eu', minTurnSilenceMs?, maxTurnSilenceMs?, endOfTurnConfidenceThreshold?, keyterms?}.
- capabilities:
  - inputFormats [MULAW_8K, PCM16_16K, PCM16_8K], frameMs {min: 50, max: 1000, preferred: 100};
  - languages per model (u3.5-pro: English + Hindi + Urdu …; no Tamil or Telugu);
  - interim true, wordTimestamps true, turnSignals ['speech-start','end-of-turn'], forceEndpoint true, ttfsP99Ms 420.
- meters [{key: 'assemblyai.streaming-stt.session_seconds', unit: 'session_seconds', role: 'stt'}]; egressHosts ['streaming.assemblyai.com', 'streaming.us.assemblyai.com', 'streaming.eu.assemblyai.com']; conformance ['stt@1'].
- Behavior:
  - wss://streaming.assemblyai.com/v3/ws (or the regional host) with header Authorization: <key> (no Bearer);
  - query: sample_rate, encoding (pcm_mulaw or pcm_s16le), speech_model, format_turns=false, plus the configured turn params;
  - send binary frames of 50–1000 ms. The host STT adapter already re-frames to 100 ms, but ALSO defensively re-aggregate in the plugin, because frames under 50 ms cause close code 3007.
  - Begin{id, expires_at, configuration?} → requestId. Check Begin.configuration.model, when present, against the requested model, and fail with a typed error on a mismatch, because unknown params are silently ignored.
  - Turn{turn_order, transcript, end_of_turn, turn_is_formatted, words[]} → a transcript segment with segmentId = String(turn_order) that replaces the text. It stays interim until end_of_turn:true, which gives final plus end-of-turn. A later formatted duplicate for the same turn_order → a revision of the same segment with formatted:true (no new turn).
  - SpeechStarted → speech-start.
  - forceEndpoint → {type: 'ForceEndpoint'}.
  - finish → {type: 'Terminate'}, then read until Termination{session_duration_seconds} → reconciled usage. Cancel or failure → estimated usage from wall clock.
  - Close codes 1008 (auth), 3005, 3006, 3007 (frame size), 3008 (expired), 3009 (concurrency) and 1011 → a typed ProviderError with a retryable flag.
- fixtureTemplates: render each caller 'say' as Begin, partial Turns, then an end_of_turn Turn, closing with Termination.
- Fixtures: Begin → partial Turns → end-of-turn → formatted duplicate (the format_turns=true variant) → Terminate → Termination. Negatives: close 3007 for a 20 ms frame, 1008 bad key, 3009, 3008, and a model mismatch in Begin.

B. packages/plugin-speech-sarvam, exporting TWO v2 plugins.
Sources: https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming, https://docs.sarvam.ai/api-reference/text-to-speech/stream.md, https://docs.sarvam.ai/api-reference/text-to-speech/convert.md, https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/web-socket.

1. STT: id '@winsendotai/ovo-stt-sarvam', kind 'stt', provider 'sarvam', provides ['ovo.stt'].
   - bindingSchema {model (default 'saaras:v3-realtime'), mode: 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix', languageCode (e.g. 'hi-IN' or 'auto'), streamType: 'fast' | 'balanced', silenceDurationMs (500), endpointing: 'vad' (default) | 'manual'}.
   - capabilities:
     - inputFormats [MULAW_8K, PCM16_8K, PCM16_16K], frameMs {min: 20, max: 1000, preferred: 100};
     - the 22 Indic languages plus en-IN (hi-IN, ta-IN, te-IN, kn-IN, ml-IN, mr-IN, bn-IN, gu-IN, pa-IN, od-IN, …);
     - interim true, turnSignals ['speech-start','speech-end','end-of-turn'];
     - forceEndpoint FALSE: the 'flush' event is documented only for endpointing=manual. When the binding sets endpointing 'manual', forceEndpoint sends {event: 'flush'}. Record this in the fixture header.
     - ttfsP99Ms 1000.
   - meters [{key: 'sarvam.streaming-stt.audio_seconds', unit: 'audio_seconds', role: 'stt'}]; egressHosts ['api.sarvam.ai'].
   - Behavior: wss://api.sarvam.ai/speech-to-text-realtime/ws with header api-subscription-key.
     - Frames are JSON {event: 'audio_input', audio: '<b64>'} of about 100 ms.
     - session.begin has no documented session id, so the requestId is synthesized as 'sarvam:<sessionId>:<n>' unless a provider id appears in a message; record this.
     - vad.speech_start → speech-start; vad.speech_end → speech-end.
     - transcript.partial → interim; transcript.final → final + end-of-turn (endpointing=vad).
     - finish → {event: 'end'} → session.end{audio_duration_s} → reconciled usage.
     - ping and pong keepalive.
     - error {event: 'error', code, is_fatal, message} and close codes 1003, 1008 and 4000 → typed errors.
2. TTS: id '@winsendotai/ovo-tts-sarvam', kind 'tts', provider 'sarvam', provides ['ovo.tts-streaming'].
   - bindingSchema {model (default 'bulbul:v3'), speaker (default 'shubh'), pace?, temperature?, dictId?, restFallback?: boolean}.
   - capabilities: outputFormats [MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K] (μ-law 8 kHz is native, so telephony needs no resampling), languages bn/en/gu/hi/kn/ml/mr/od/pa/ta/te-IN, incrementalText true, maxChars 2500.
   - meters [{key: 'sarvam.streaming-tts.characters', unit: 'characters', role: 'tts'}].
   - Behavior: WebSocket wss://api.sarvam.ai/text-to-speech/ws?model=…&send_completion_event=true with header Api-Subscription-Key.
     - Send config (speaker, target language, the output codec and sample rate matching the requested native format, pace), then text, then flush.
     - Receive audio{audio, content_type, request_id}, then event{event_type: 'final'}.
     - An error frame → a typed error. Handle the roughly 60 s idle close with ping.
     - open() implements IncrementalTts (push, flush, audio, close), which enables pipelining in the native engine.
     - synthesize() uses the WebSocket, with a REST fallback (POST https://api.sarvam.ai/text-to-speech → {request_id, audios: [b64]}) when restFallback is set.
     - cacheIdentity {provider: 'sarvam', model, voice: speaker, revision: 'sarvam-<codec>-<rate>-v1'}.
     - The request field name is AMBIGUOUS (language_code vs target_language_code). Decide from the pinned doc page, record it verbatim in the fixture header, and mark the other UNCONFIRMED.

- fixtureTemplates for both plugins: STT renders each 'say' as vad.speech_start → transcript.partial×n → vad.speech_end → transcript.final; TTS renders base64 μ-law audio frames for each text, then final.
- Fixtures:
  - STT: session.begin → vad.speech_start → transcript.partial×n → vad.speech_end → transcript.final → end → session.end; plus an error with is_fatal, closes 4000 and 1003, and an idle 1008.
  - TTS: config → text → flush → audio×n (base64 μ-law 8k) → final; an error frame; canned REST JSON.

TESTS: each package has tests/conformance.test.ts running describeSpeechToText and/or describeTextToSpeech with FixtureNet scripts and templates. src/testing.ts exports fixtures and fixtureTemplates, and index.ts re-exports them. Also test:

- AssemblyAI frame aggregation never sends frames under 50 ms or over 1000 ms;
- the model-mismatch failure;
- Sarvam incremental open() streams audio after flush;
- Sarvam forceEndpoint is absent with VAD endpointing and sends flush with manual endpointing;
- usage is emitted exactly once on finish, cancel and fatal error;
- requestId is always present.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/S2.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- Import only contracts, runtime, sdk, plugin-kit and audio. No other plugin packages. No ws or node:https.
- Never contact provider hosts in tests; live flags stay off.
- Modules ≤300 lines. No git commits.

## Acceptance

- The AssemblyAI STT, Sarvam STT and Sarvam TTS plugins load via the distribution catalog without skeleton flags and pass their conformance kits, using doc-faithful FixtureNet scripts, fixture templates and UNCONFIRMED annotations.
- AssemblyAI never sends frames outside 50–1000 ms, checks the model echoed in Begin, maps turn_order and end_of_turn correctly (a formatted duplicate is a revision), and reconciles session_seconds from Termination.
- Sarvam STT maps the vad and transcript events to speech-start, speech-end, interim, final and end-of-turn, reconciles audio_duration_s from session.end, synthesizes the requestId, and exposes forceEndpoint only with manual endpointing.
- Sarvam TTS outputs μ-law 8 kHz natively, supports incremental open(), and meters characters.
- Usage is emitted exactly once with a requestId on finish, cancel and failure. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-stt-assemblyai packages/plugin-speech-sarvam`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-stt-assemblyai packages/plugin-speech-sarvam`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-stt-assemblyai packages/plugin-speech-sarvam packages/distribution --reporter=dot`
