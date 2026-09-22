# Work unit S1-speech-split: Split plugin-providers into Deepgram STT, OpenAI TTS and OpenAI LLM v2 plugin packages, with native formats only, Deepgram usage fix, meters.when and fixture templates

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [21, 27]

## Owned paths

- packages/plugin-providers/**
- packages/plugin-inference/**
- packages/plugin-stt-deepgram/**
- packages/plugin-tts-openai/**
- packages/plugin-llm-openai/**
- scripts/baselines/pending/S1.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: turn the hardwired Deepgram and OpenAI providers into ordinary v2 plugin packages, selected per agent, and fix their known bugs. Read docs/architecture/plugin-platform.md (revision 2): sections 2.3–2.4 (plugins declare NATIVE formats only; session-host's format adapters transcode), section 3 and section 9.

What already exists and is frozen:

- the v2 contracts (SpeechToText, SttSession, SttEvent, TextToSpeech, UsageMeter, NetPort, FixtureTemplate);
- plugin-kit (openProviderSocket, httpJson, sseReader, abort helpers and AiSdkInference, which F2 moved there);
- @winsendotai/ovo-audio.
  Plugins get credentials via ctx.secret('/credentialRef'), binding config via row config 'binding', and network ONLY via ctx.net. The gate forbids ws and node:https here. Usage goes to the onUsage sink exactly once, always with a requestId.

F3 created the skeletons packages/plugin-stt-deepgram, plugin-tts-openai and plugin-llm-openai (the LLM one depends on @ai-sdk/openai 4.0.71 and ai 7.0.107) with catalog entries. Fill them and remove the ovo.skeleton flags. The distribution legacy bridges have the SAME plugin ids and are superseded automatically by the loader's same-id rule. Do NOT edit distribution or plugin-kit; I1 deletes the bridges.

A. packages/plugin-stt-deepgram. Move deepgram.ts, deepgram-session.ts and deepgram-transport.ts from plugin-providers.

- v2 plugin: id '@winsendotai/ovo-provider-deepgram-stt' (KEEP), kind 'stt', provider 'deepgram', session scope, provides ['ovo.stt'].
- bindingSchema {model (default 'nova-3'), language?, endpointingMs?, utteranceEndMs (default 1000), keyterms?}.
- capabilities:
  - inputFormats [MULAW_8K, PCM16_8K, PCM16_16K];
  - languages per model (hi, en-IN, multi, …); mark Tamil and Telugu UNCONFIRMED and exclude them;
  - interim true, wordTimestamps true, turnSignals ['speech-start','end-of-turn','utterance-end'], forceEndpoint true, ttfsP99Ms 350.
- meters [{key: 'deepgram.streaming-stt.audio_seconds', unit: 'audio_seconds', role: 'stt'}]; egressHosts ['api.deepgram.com']; conformance ['stt@1'].
- Behavior:
  - wss://api.deepgram.com/v1/listen with Authorization: Token <key>;
  - query: encoding and sample_rate from the requested native format (mulaw or linear16), interim_results=true, vad_events=true, utterance_end_ms, punctuate, smart_format;
  - Results with is_final false → interim for the current segment; is_final true → final, after which the segmentId advances; speech_final → end-of-turn; UtteranceEnd → utterance-end; SpeechStarted → speech-start;
  - forceEndpoint sends {type: 'Finalize'} (results carry from_finalize); KeepAlive every 5 s; finish sends {type: 'CloseStream'} and waits for Metadata.
- USAGE FIX: reconciled usage comes ONLY from the final Metadata.duration, with requestId = metadata.request_id. If the socket fails or closes before Metadata, emit an estimated usage from bytes written / bytesPerSecond(format). Never take Math.max over Results durations (the bug at deepgram-session.ts:153-158).
- fixtureTemplates['@winsendotai/ovo-provider-deepgram-stt']: renders each caller 'say' as doc-faithful Results messages (interims, then is_final, then is_final + speech_final), plus UtteranceEnd and SpeechStarted, and closes with Metadata.
- Fixtures (doc-faithful, https://developers.deepgram.com/docs/understanding-end-of-speech-detection):
  - interim → is_final (no speech_final) → is_final + speech_final;
  - interim → is_final → UtteranceEnd without speech_final;
  - SpeechStarted;
  - Finalize → from_finalize;
  - CloseStream → Metadata;
  - an abrupt 1011 before Metadata → estimated usage.
- Move tests/deepgram.test.ts and tests/tls.ts, adapted to FixtureNet.

B. packages/plugin-tts-openai. Move openai-tts.ts, and openai-transcription.ts as a separate batch-STT manifest if anything still uses it.

- v2 plugin: id '@winsendotai/ovo-provider-openai-tts' (KEEP), kind 'tts', provider 'openai', provides ['ovo.tts-streaming'].
- bindingSchema {model: 'gpt-4o-mini-tts' | 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts-2025-12-15', voice, instructions?, speed?}.
- capabilities: outputFormats [PCM16_24K] ONLY, languages ['*'], incrementalText false, maxChars 4096. The plugin NEVER resamples; the session-host TTS adapter converts to the carrier format with the polyphase resampler (#27a).
- meters:
  - {key: 'openai.streaming-tts.characters', unit: 'characters', role: 'tts', when: {field: 'model', in: ['tts-1','tts-1-hd']}};
  - 'openai.streaming-tts.input_tokens' and 'openai.streaming-tts.audio_output_tokens' with when model in the gpt-4o-mini-tts variants.
- egressHosts ['api.openai.com'].
- Behavior: POST /v1/audio/speech.
  - For gpt-4o-mini-tts use stream_format 'sse': parse speech.audio.delta (base64 PCM 24k); speech.audio.done usage → reconciled token usage.
  - For tts-1*: the raw chunked pcm body, with estimated character usage.
  - Handle odd-byte chunk boundaries.
  - cacheIdentity(format, voice) returns revision 'openai-tts-mulaw-8000-v1' when format is MULAW_8K (it is called with the requested format), so cache keys stay stable.
- fixtureTemplates: renders SSE deltas (or a chunked pcm body) for each agent text, sized to the text.
- Fixtures: a chunked PCM body with an odd-byte split; SSE deltas plus done{usage}; 429 and 500.

C. packages/plugin-llm-openai

- v2 plugin: id '@winsendotai/ovo-provider-openai-inference' (KEEP), kind 'llm', provider 'openai', provides ['ovo.inference'].
- bindingSchema {model, temperature?, maxOutputTokens?}; capabilities {tools: true, streaming: true}.
- meters: the existing openai.inference.* keys used by the cost runtime and price cards. egressHosts ['api.openai.com'].
- Implementation: create the AI SDK model from @ai-sdk/openai (moved out of plugin-providers) with fetch bound to ctx.net.fetch, and wrap it with plugin-kit's AiSdkInference. Inference exposes provider and model, and token usage flows to the usage sink.
- fixtureTemplates: renders the provider HTTP streaming response that this @ai-sdk/openai version actually requests (check which OpenAI API it calls). On the first user turn it calls the agent's first write tool with schema-valid input, then answers in text. It must work with the real AiSdkInference under FixtureNet.

D. Façades and removal

- packages/plugin-providers becomes a re-export façade: the old factory names and binding parsers delegate to the new packages, kept only for remaining imports (for example the distribution legacy bridges). The legacy kind is not edge-checked. I1 deletes it.
- Delete plugin-providers/src/audio.ts (the box filter), and re-export from @winsendotai/ovo-audio if something still imports it.
- packages/plugin-inference keeps the simulated inference exports session-host uses (stable names). src/ai-sdk.ts stays a re-export of plugin-kit.

TESTS:

- tests/conformance.test.ts in each new package runs describeSpeechToText, describeTextToSpeech or describeInference with FixtureNet scripts and the templates. src/testing.ts exports fixtures and fixtureTemplates, and index.ts re-exports them.
- A Deepgram usage test: estimated, not reconciled, when the socket dies before Metadata.
- An OpenAI TTS 6 kHz alias test through the real output path: wrap the plugin with the session-host TTS format adapter (frozen; import it in the test), request MULAW_8K, and check ≥60 dB attenuation.
- The LLM template drives a tool call through AiSdkInference.
- The existing plugin-providers tests are moved and adapted.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen (distribution, plugin-kit, session-host, lockfile).
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional duplication goes in scripts/baselines/pending/S1.json with removeBy 'I1'.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- New packages import only contracts, runtime, sdk, plugin-kit, audio and third-party (@ai-sdk/openai, ai). No other plugin packages. No ws or node:https.
- No real provider traffic; live flags stay off.
- Modules ≤300 lines. No git commits.

## Acceptance

- Three new v2 plugin packages keep the existing plugin ids, supersede the legacy bridges in the loaded catalog, drop the skeleton flag, and pass their conformance kits with FixtureNet scripts and fixture templates.
- Deepgram emits end-of-turn on speech_final, utterance-end on UtteranceEnd and speech-start on SpeechStarted, sends Finalize on forceEndpoint, and reports reconciled usage only from Metadata (estimated on an abrupt close).
- OpenAI TTS declares only PCM16_24K and never resamples. The alias test through the host TTS adapter passes (≥60 dB). SSE token usage is used for gpt-4o-mini-tts, meters use when by model, and the MULAW_8K cache identity is unchanged.
- The OpenAI LLM plugin exposes provider and model, emits token usage, and its fixture template drives a tool call through AiSdkInference.
- plugin-providers is only a façade and the box filter is deleted. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-stt-deepgram packages/plugin-tts-openai packages/plugin-llm-openai packages/plugin-providers packages/plugin-inference`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-stt-deepgram packages/plugin-tts-openai packages/plugin-llm-openai packages/plugin-providers packages/plugin-inference packages/distribution packages/session-host`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-stt-deepgram packages/plugin-tts-openai packages/plugin-llm-openai packages/plugin-providers packages/plugin-inference packages/distribution --reporter=dot`
