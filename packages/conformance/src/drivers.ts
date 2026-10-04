/**
 * `@winsendotai/ovo-conformance/drivers`: host-side test drivers with NO vitest import, directly
 * or transitively. `packages/fixture-calls` uses them at runtime (§12).
 */
export * from './drivers/audio-gen.ts';
export * from './drivers/carrier-host-ports.ts';
export * from './drivers/egress-sentinel.ts';
export * from './drivers/fake-carrier.ts';
export * from './drivers/fake-clock.ts';
export * from './drivers/fixture-carrier.ts';
export * from './drivers/fixture-llm.ts';
export * from './drivers/fixture-plugins.ts';
export * from './drivers/fixture-stt.ts';
export * from './drivers/fixture-tts.ts';
export * from './drivers/jsonl.ts';
export * from './drivers/loopback-server.ts';
export * from './drivers/rfc6455-client.ts';
export * from './drivers/scripted-inference.ts';
export * from './drivers/scripted-speech.ts';
export * from './reference/engine.ts';
export * from './reference/engine-playback.ts';
export * from './reference/turn-detector.ts';
export * from './reference/vad.ts';
export type { EngineFactory, EnginePorts, EngineUnderTest } from './kit/engine-ports.ts';

import { createReferenceTurnDetector } from './reference/turn-detector.ts';

/** The kit's fake turn detector: the reference controller, whose instances accept `emit(decision)`. */
export const fakeTurnDetector = createReferenceTurnDetector;
