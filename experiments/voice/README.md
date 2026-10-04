# OVO voice experiments

Disposable, deterministic comparison fixtures for a focused OVO/AI SDK loop and the real LiveKit Agents JS `AgentSession` API.

```sh
pnpm --filter @winsendotai/ovo-voice-experiments typecheck
pnpm --filter @winsendotai/ovo-voice-experiments test
pnpm --filter @winsendotai/ovo-voice-experiments benchmark
```

The fixtures make no network or paid provider calls. LiveKit runs in text-only/no-audio mode with its exported `FakeLLM`; AI SDK uses its exported mock model. LiveKit local inference is explicitly disabled with `vad: null`, turn detection disabled, and no local model APIs. Do not extract or reuse the transitively installed LiveKit model weights in focused OVO.

Results establish local API behavior and ordering only. They do not verify STT, VAD, TTS, audio playback, WebRTC, or carrier transport and are not production engine selection evidence. See the research comparison for transitive model and FFmpeg license obligations.
