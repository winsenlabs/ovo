import { beforeAll, afterAll, expect, it } from 'vitest';
import { installEgressSentinel, type EgressSentinel } from '@winsendotai/ovo-conformance/drivers';
import { assertEnvironment, assertOptions } from '../src/guards.ts';
let sentinel: EgressSentinel;
beforeAll(() => {
  sentinel = installEgressSentinel({ allowLoopback: false });
});
afterAll(() => {
  try {
    expect(sentinel.attempts).toEqual([]);
  } finally {
    sentinel.restore();
  }
});
it('refuses omitted VAD and omitted turn detection before constructing inference defaults', () => {
  expect(() => assertOptions({ turnHandling: { turnDetection: 'stt' } })).toThrow(
    'explicit vad:null',
  );
  expect(() => assertOptions({ vad: null })).toThrow('turnDetection:stt');
  expect(() => assertOptions({ vad: null, turnHandling: { turnDetection: 'stt' } })).not.toThrow();
});
it('refuses credentials and implicit model IDs', () => {
  expect(() => assertEnvironment({ LIVEKIT_API_KEY: 'must-not-be-used' })).toThrow(
    'refuses LIVEKIT_*',
  );
  expect(() =>
    assertOptions({ vad: null, stt: 'inference/model', turnHandling: { turnDetection: 'stt' } }),
  ).toThrow('inference model IDs');
  expect(() =>
    assertOptions({ vad: null, llm: {}, turnHandling: { turnDetection: 'stt' } }),
  ).toThrow('an LLM');
});

it('rejects real inference prototypes even though their constructors are named STT/TTS/VAD', async () => {
  const { inference } = await import('@livekit/agents');
  const { assertSession } = await import('../src/guards.ts');
  for (const Constructor of [inference.STT, inference.TTS, inference.VAD, inference.TurnDetector]) {
    const session = { stt: Object.create(Constructor.prototype), tools: [] };
    const agent = { toolCtx: { tools: [] } };
    expect(() => assertSession(session as never, agent as never, inference)).toThrow(
      'refuses inference',
    );
  }
});
