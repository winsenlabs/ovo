import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { expect, it } from 'vitest';
import { createNativeVoiceEngineV2Plugin } from '../src/engine/plugin.ts';
import { DEFAULT_PRE_STT_BUFFER_MS, ingressLimitsFor } from '../src/engine/ingress-backlog.ts';

it('advertises the pre-STT span the engine applies when the release leaves it unset', () => {
  const schema = createNativeVoiceEngineV2Plugin().manifest.configSchema as {
    properties: { engine: { properties: { preSttBufferMs: { default: number } } } };
  };
  // Regression: the schema said 10 s after the engine moved to 15 s for a 6 s STT connect deadline.
  expect(schema.properties.engine.properties.preSttBufferMs.default).toBe(
    DEFAULT_PRE_STT_BUFFER_MS,
  );
  expect(DEFAULT_PRE_STT_BUFFER_MS).toBe(15_000);
  // Fifteen seconds of 10 ms frames fit the ingress queue without a configured limit.
  expect(ingressLimitsFor({}, MULAW_8K)).toMatchObject({
    maxFrames: 1_500,
    preSttBufferMs: 15_000,
  });
});
