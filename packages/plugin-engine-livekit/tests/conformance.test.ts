import { afterAll, beforeAll, expect } from 'vitest';
import { describeEngine } from '@winsendotai/ovo-conformance';
import { installEgressSentinel, type EgressSentinel } from '@winsendotai/ovo-conformance/drivers';
import { CAPABILITIES } from '../src/plugin.ts';

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
describeEngine(
  'LiveKit 1.9.0 no-room OVO adapters',
  async (ports) => {
    const { LiveKitEngine } = await import('../src/session-runner.ts');
    const engine = new LiveKitEngine(ports);
    return { engine, speech: engine.speech, capabilities: CAPABILITIES };
  },
  { turnDetector: 'none', timeoutMs: 12000 },
);
