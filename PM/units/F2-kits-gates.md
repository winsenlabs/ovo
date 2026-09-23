# Work unit F2-kits-gates: Shared kits (plugin-kit incl. AiSdkInference and tool errors, audio, conformance with a vitest-free drivers entry) and code-hygiene gates with explicit package kinds, pending baselines and scoped verification

Wave: 1
Depends on: F1-contracts-runtime
Defects fixed: [24, 27, 12]

## Owned paths

- packages/plugin-kit/**
- packages/audio/**
- packages/conformance/**
- packages/plugin-tools/src/errors.ts
- packages/plugin-inference/src/ai-sdk.ts
- scripts/check-architecture.mjs
- scripts/check-module-size.mjs
- scripts/check-duplication.mjs
- scripts/check-provider-names.mjs
- scripts/check-capability-keys.mjs
- scripts/check-conformance.mjs
- scripts/check-terraform.mjs
- scripts/lint.mjs
- scripts/typecheck-scope.mjs
- scripts/package-kinds.json
- scripts/vitest-global-setup.ts
- scripts/vitest-violation-sink.ts
- scripts/baselines/**
- scripts/tests/**
- vitest.config.ts
- package.json
- tsconfig.json
- apps/console/package.json (devDependencies only)

## Shared touchpoints (minimal edits allowed)

- pnpm-lock.yaml

## Specification

GOAL: build the non-plugin libraries that plugins may import, the conformance kits every plugin kind must pass, and the lint gates that keep the architecture honest. Wave 2 then runs in parallel without editing shared files. Read docs/architecture/plugin-platform.md (revision 2): sections 2.3, 2.4, 2.5, 2.6, 2.8, 2.11, 13 and 15. Contracts exist (F1). Wave 2 freezes everything you build here, so every helper listed below must exist.

A. packages/plugin-kit: name @winsendotai/ovo-plugin-kit; dependencies contracts plus the third-party ws@8.21.3 and ai@7.0.107 (both in the store); no other workspace packages.

- net.ts: createNodeNet(). A NetPort over undici fetch and ws that accepts only https: and wss:, with a per-call AbortSignal, and that enforces the address policy: assertPublicHost on every call, DNS answers validated before connect, the connection pinned to a validated address, and any socket that lands on a private address destroyed before a request byte is written. Loopback is reachable in tests only through an explicit list of exact addresses (`allowedPrivateAddresses`), never a boolean.
- fixture-net.ts: createFixtureNet(scripts: NetFixtureScript[]), keyed by script.host. It is an in-memory NetPort that replays scripts strictly:
  - fetch matches an 'http' step (method, url, optional json or form body matcher with where) and returns its reply;
  - websocket matches 'ws-open' (including header checks), then drives the ws-send, send, close and delayMs steps;
  - an unexpected request or frame throws a FixtureMismatchError naming the step;
  - it supports repeat 'until-next' for streaming audio frames;
  - time comes from an injectable Clock.
- ssrf.ts: isPublicAddress(ip) and assertPublicHost(host, lookup).
  - Copy the logic from packages/plugin-tools-http/src/network.ts, then add #24: IPv4-compatible ::a.b.c.d, ::ffff:a.b.c.d, fec0::/10, 6to4 2002::/16 (check the embedded IPv4), Teredo 2001::/32 (check the de-obfuscated client IPv4) and NAT64 64:ff9b::/96 (check the embedded IPv4), plus every existing private, loopback, link-local and ULA range.
  - Leave tools-http untouched; M1 switches it over.
- abort.ts and http.ts: copy from plugin-providers. httpJson classifies 4xx as rejected (retryable only on 429), and 408, 5xx and timeouts as unknown.
- provider-socket.ts: openProviderSocket(net, url, headers, allowHosts), with a keepalive helper.
- sse.ts: an SSE line reader.
- tool-errors.ts: move every class from packages/plugin-tools/src/errors.ts (ExecutionPolicyError, ConfirmationRequiredError, OperationCollisionError, ToolSchemaError, ToolInvocationError and the rest), and add ConnectorPolicyError extends ExecutionPolicyError. plugin-tools/src/errors.ts becomes a re-export.
- ai-sdk-inference.ts: move AiSdkInference from packages/plugin-inference/src/ai-sdk.ts. It is generic over any AI SDK LanguageModel, exposes provider and model, and reports token usage to a UsageSink. plugin-inference/src/ai-sdk.ts becomes a re-export.
- speech-shims.ts: legacyAsStt, sttAsLegacy, legacyAsTts, ttsAsLegacy, duplexFromLegacy and legacyFromDuplex, using the contracts speech/legacy.ts types. Mapping per section 2.11:
  - isFinal → final segment, with a new segmentId after each final;
  - speechFinal → end-of-turn;
  - speechStarted → speech-start.
- index.ts.

B. packages/audio: name @winsendotai/ovo-audio; dependencies contracts only.

- g711.ts: μ-law and A-law encode and decode tables.
- pcm.ts: bytes ↔ Int16 LE.
- polyphase-resampler.ts:
  - stateful, Kaiser-windowed sinc; the prototype length is DERIVED from the stop-band attenuation
    and transition width (Kaiser's estimate), not fixed per phase — see the checker note below;
  - ratios 24k→8k, 24k→16k, 16k→8k and 8k→16k (and every other pair of RESAMPLER_RATES);
  - history carried across push(); clearAfterIdleMs 200; flush() drains the whole tail;
  - equal rates pass through unfiltered;
  - stop-band ≥60 dB for EVERY fold-back frequency, not at one probe point.

  > **Checker note (2026-09-23).** As first written this bullet asked for both "about 48 taps per
  > phase" and "stop-band ≥60 dB". Those are not simultaneously satisfiable: for a pure decimation
  > (L=1) such as 24k→8k, 48 taps puts the 60 dB stop-band edge ~600 Hz above the output Nyquist,
  > so 4.0–4.6 kHz folds back at only 20–30 dB down — audible aliasing of sibilants on the main
  > 24 kHz-TTS-to-8 kHz-carrier path. The tap count is now derived; measured worst-case rejection
  > is −76 to −79 dB on all pairs, and pass-band deviation ≤0.01 dB to 0.85·Nyquist.

- codec-graph.ts: plan(from, to) returns steps or undefined, plus reachable() and a createTranscoder(plan) that is stateful and handles odd-byte chunks.
- frame-aggregator.ts and silence.ts.
- Tests:
  - every fold-back frequency in the transition band is ≥60 dB below a reference tone, swept per
    rate pair (a single 6 kHz probe resamples to digital silence and proves nothing);
  - 1 kHz passes within 0.5 dB;
  - output from 7-sample and 1-byte chunks is bit-identical to one-shot output;
  - μ-law round-trips all 256 codes;
  - the codec graph finds μ-law 8k → PCM16 16k and rejects impossible targets.

C. packages/conformance: name @winsendotai/ovo-conformance; a test-only host library. It may import contracts, runtime, sdk, plugin-kit, audio, behaviors and vitest.

- The package has TWO entries:
  - '.': the kits; these may import vitest.
  - './drivers': must NOT import vitest, directly or transitively. fixture-calls uses it at runtime.
- Each kit exposes BOTH describeX(name, factory, opts) (vitest) AND checkX(...), which returns a list of failures for meta-testing. The kits are describeSpeechToText, describeTextToSpeech, describeInference, describeCarrier, describeEngine, describeVad and describeTurnDetector.
- STT invariants:
  - revisions are monotonic;
  - a final locks its segment;
  - usage is emitted exactly once on finish, cancel and failure;
  - requestId is always present;
  - cancel closes within 1 s;
  - frameMs limits are honoured;
  - no write after finish;
  - all network goes through the injected NetPort;
  - fixtureTemplates, when present, render a scripted utterance into the plugin's own messages and produce matching final text.
- TTS invariants: output is in the requested native format, abort works mid-stream, cacheIdentity is stable, usage is emitted once, and templates render audio.
- Carrier invariants:
  - the plugin's jsonl transcripts run through its MediaSerializer and MediaCodecSession;
  - REST shapes are checked via FixtureNet;
  - positive and negative signature vectors;
  - status-map snapshot;
  - dial rejects a non-wss or query-bearing media URL;
  - on-answer carriers: the answer or media-url route calls host.streamForDial and returns a grant; 'ended' produces hang-up markup;
  - close-stream carriers: terminate() frames;
  - per-call url-secret verification;
  - hangup by request id when cancelBeforeAnswer.
- Engine scenarios, using the real behaviors from @winsendotai/ovo-behaviors where possible:
  - announcement with no input;
  - FAQ with no LLM;
  - supplied context and agent+tools, with a scripted Inference;
  - DTMF digits;
  - variables reach every behavior call, including DTMF turns;
  - barge-in mid-segment;
  - a write tool with confirmation heard as 'confirmed';
  - an interrupted confirmation does not execute;
  - 'yes' spoken while the confirmation prompt is still playing is dispatched only after the prompt's receipt is delivered (receipt ordering, section 2.6);
  - Execution progress speech goes through ovo.speech and the engine's media path (companions, section 2.2), and no second writer reaches the media;
  - pending marks are cancelled before clear;
  - exactly one Execution.execute per operation, and the engine never touches execution;
  - speech evidence phases are in order;
  - dispose is bounded and idempotent;
  - the outcome enum on caller hangup.
- Turn-detector scenarios cover the section 2.7 mute semantics and confirmation answers.
- './drivers' exports:
  - the fake-carrier driver: an in-memory playback clock that drains queued audio at real-time rate from bytesPerSecond, echoes marks on drain or clear according to the capability flags, and synthesizes 'cleared';
  - a raw RFC 6455 loopback client that can send masked, fragmented frames and interleaved pings;
  - fixtureCarrierIngress: a Twilio-shaped reference CarrierIngress, with an optional on-answer mode;
  - a loopback WS and HTTP fixture server (generalise packages/plugin-providers/tests/tls.ts);
  - FakeClock;
  - seeded audio generators;
  - an egress sentinel that stubs net.connect, tls.connect, fetch and WebSocket to throw and deletes LIVEKIT_*;
  - scripted STT and TTS fakes, a fake MediaDuplex, fakeTurnDetector and a CarrierHostPorts fake with streamForDial and resumeStream;
  - fixture-kind test plugins: stt and tts with provider 'fixture', egressHosts ['fixture.invalid'], matching scripts and templates;
  - loadJsonlFixture(), which validates the header {source, retrieved, verbatim, unconfirmed}.

D. Gates (doc section 13). Each gate is a script plus a test in scripts/tests/_.test.ts that runs it against scripts/tests/fixtures/<gate>/, a folder with a known violation. When scanning the repository, every gate skips path segments named fixtures, **fixtures**, node_modules, dist, .next, upstream and vendor; gate tests pass their fixture folder as an explicit root. Every gate accepts --only <path-prefix>... and reports only files under those prefixes. Every gate reads scripts/baselines/<gate>.json plus every scripts/baselines/pending/_.json. Pending entries carry reason and removeBy 'I1'. Top-level baselines are generated with a --write-baseline flag. Stale entries warn, never fail.

1. scripts/package-kinds.json: an explicit map from package directory to kind (contracts, runtime, sdk, kit, test-kit, host, distribution, vendor-plugin, plugin, legacy, app, console, experiment), per the section 13 table. List every current package AND every package this plan creates:
   - session-host, distribution and fixture-calls → host or distribution kinds as the table says;
   - plugin-turns, plugin-vad, plugin-engine-livekit, plugin-carrier-twilio, plugin-carrier-exotel, plugin-carrier-plivo, plugin-stt-deepgram, plugin-tts-openai, plugin-llm-openai, plugin-stt-assemblyai and plugin-speech-sarvam → vendor-plugin;
   - plugin-voice → vendor-plugin;
   - plugin-providers, plugin-telephony-twilio and plugin-session → legacy.
     plugin-speech-cache is a plugin, NOT a vendor-plugin.
2. check-module-size.mjs:
   - source limit 300, tests 500, and 24 KiB;
   - the baseline module-size.json maps today's 301–400-line files to their counts, which may not grow;
   - 400 is a hard cap for everything, pending entries included.
3. check-duplication.mjs (new, in-house):
   - a TypeScript scanner (use the typescript devDependency) that drops comments and whitespace and collapses string literals;
   - a rolling hash over 60-token windows across apps/_/src, apps/console/{app,components,features,lib} and packages/_/src;
   - skips tests, fixtures, upstream and vendor;
   - fails on cross-file repeats that are not in any baseline;
   - with --only, reports windows that have at least one occurrence under the prefixes.
     Your own kit copies (ssrf, http, abort) go in the top-level baseline; S1 and M1 remove them.
4. check-architecture.mjs: keep every current check, including PM acceptance 75, the namespace and private checks, and private keys. Add the section 13 kind table, driven by package-kinds.json, with baseline architecture.json (today's plugin→plugin and app→vendor edges).
5. check-provider-names.mjs: per section 13.4, with a per-file count baseline.
6. check-capability-keys.mjs: a ratchet with a baseline.
7. check-conformance.mjs:
   - every vendor-plugin package needs tests/conformance.test.ts that imports @winsendotai/ovo-conformance and calls a describe* kit;
   - packages whose package.json has the field ovo.skeleton set to true are exempt;
   - plugin-voice goes in the baseline.
8. check-terraform.mjs: runs the binary, else docker hashicorp/terraform:1.10, else prints SKIPPED and exits 0.
9. scripts/lint.mjs runs architecture, upstream, module-size, duplication, provider-names, capability-keys and conformance in sequence, forwarding --only. The root package.json lint becomes 'node scripts/lint.mjs'. Add scripts check:terraform and test:console:e2e (which runs pnpm --filter @winsendotai/ovo-console e2e if that script is defined).
10. scripts/typecheck-scope.mjs <prefix>...: runs the root 'tsc --noEmit -p tsconfig.json --pretty false' (after build:vendor if needed), exits 1 only for diagnostics in files under the prefixes, and prints the count of out-of-scope diagnostics as warnings.
11. vitest.config.ts:
    - add include globs infra/**/\*.test.ts and scripts/**/*.test.ts;
    - setupFiles [scripts/vitest-violation-sink.ts], which calls runtime setViolationSink and appends JSONL to process.env.OVO_PLUGIN_VIOLATION_LOG;
    - globalSetup scripts/vitest-global-setup.ts, which creates a temp log path and, in teardown, dedupes by (pluginId, kind, key) and fails on entries missing from runtime-violations.json and from every pending file's runtimeViolations. Generate the baseline from a full suite run.
    - If jsdom resolves, add projects 'node' (all current globs) and 'console-dom' (apps/console/**/*.test.tsx, environment jsdom). Otherwise exclude .test.tsx.
    - Include scripts/**/\*.ts and infra/**/*.ts in tsconfig.json if typecheck needs them.
12. Console test dependencies: try `pnpm --filter @winsendotai/ovo-console add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom @playwright/test @axe-core/playwright` ONCE. If the network is unavailable, revert any partial change to apps/console/package.json and pnpm-lock.yaml and record the result in your report. Wave 2 cannot install anything.

CONSTRAINTS:

- Kits must not import any plugin-* package.
- Modules ≤300 lines; measure with node scripts/check-module-size.mjs.
- No network in tests beyond loopback.
- Do not relax any existing gate.
- Keep pnpm lint, typecheck and test green (full repo).
- No git commits.

## Acceptance

- pnpm lint runs scripts/lint.mjs with all 7 gates and passes on the current repo using the committed baselines. Each gate has a test proving it fails on its fixture violation (including a new 301-line source file) and that --only limits what it reports.
- No gate scans fixture directories. package-kinds.json lists every current and planned package, and plugin-speech-cache is classified as plugin, not vendor-plugin.
- Pending baselines under scripts/baselines/pending/*.json are merged by every gate and by the runtime-violation teardown. Skeleton packages are exempt from check-conformance.
- scripts/typecheck-scope.mjs fails only on in-scope diagnostics.
- The audio resampler meets the alias-rejection (≥60 dB), passband (0.5 dB) and chunk-invariance tests. μ-law round-trips all 256 codes. codec-graph planning and the stateful transcoder are tested.
- ssrf.ts rejects every #24 range and still accepts public IPv4 and IPv6 addresses (table-driven test). FixtureNet replays HTTP and WebSocket scripts strictly and throws FixtureMismatchError.
- AiSdkInference and the tool error classes (including ConnectorPolicyError) live in plugin-kit. plugin-inference and plugin-tools re-export them, and their existing tests pass.
- Each conformance kit passes against the in-kit reference fakes, and checkX reports failures for a deliberately broken fake. The engine kit covers companions or ovo.speech, receipt ordering and clear ordering. @winsendotai/ovo-conformance/drivers imports no vitest (tested).
- vitest picks up scripts/**/\*.test.ts and infra/**/*.test.ts. The violation baseline exists, and the full suite passes. check-terraform prints SKIPPED and exits 0 without terraform.
- The console test-dependency install was attempted once, and the outcome is recorded.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm install --offline`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm lint`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm typecheck`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-kit packages/audio packages/conformance scripts packages/plugin-tools packages/plugin-inference --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/check-terraform.mjs`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm test`
