import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createFakeCarrier,
  createScriptedStt,
  createScriptedTts,
  installEgressSentinel,
  realClock,
  type EgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
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
async function setup(inputEnabled = true) {
  const { LiveKitEngine } = await import('../src/session-runner.ts');
  const carrier = createFakeCarrier(),
    stt = createScriptedStt(),
    turns: string[] = [];
  const cancel = vi.fn();
  const engine = new LiveKitEngine({
    media: carrier.duplex,
    stt: inputEnabled ? stt : undefined,
    tts: createScriptedTts(),
    clock: realClock,
    usage() {},
    behavior: {
      async respond(text) {
        turns.push(text);
        return '';
      },
      cancel,
    },
    session: {
      mode: 'faq',
      language: 'en-US',
      inputEnabled,
      variables: {},
      maxCallSeconds: 60,
      acknowledgements: [],
    },
  });
  return { engine, carrier, stt, turns, cancel };
}
it('deduplicates final segment IDs before the real LiveKit transcript accumulator', async () => {
  const h = await setup();
  try {
    await h.engine.start();
    const stt = await h.stt.session();
    stt.emit({ type: 'speech-start' });
    for (const revision of [1, 2])
      stt.emit({
        type: 'transcript',
        segment: { segmentId: 'same', revision, stability: 'final', text: 'book Friday' },
      });
    stt.emit({ type: 'end-of-turn' });
    await vi.waitFor(() => expect(h.turns).toEqual(['book Friday']), { timeout: 10000 });
  } finally {
    await h.engine.dispose('drain');
  }
}, 60000);
it('a synchronous media close failure cannot skip local cancellation or ingress detachment', async () => {
  const h = await setup(false);
  const original = h.carrier.duplex.close;
  h.carrier.duplex.close = () => {
    throw new Error('sync transport close failure');
  };
  try {
    await expect(h.engine.dispose('drain', { deadlineMs: 50 })).resolves.toMatchObject({
      reason: 'drain',
    });
    h.carrier.caller.audio(new Uint8Array(160));
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.engine.ingressStats.acceptedFrames).toBe(0);
    await expect(h.engine.ended).resolves.toMatchObject({ reason: 'drain' });
  } finally {
    h.carrier.duplex.close = original;
    // Also cleans the intentionally broken-version run without trusting dispose's own cleanup.
    await (h.engine as unknown as { input: { close(): Promise<void> } }).input.close();
    await h.engine.session.close();
    await original('drain');
  }
}, 60000);
it('throwing end observers do not prevent ended or the remaining observers', async () => {
  const h = await setup(false),
    observed = vi.fn();
  h.engine.subscribe(() => {
    throw new Error('broken observer');
  });
  h.engine.subscribe(observed);
  await expect(h.engine.dispose('drain')).resolves.toMatchObject({ reason: 'drain' });
  await expect(h.engine.ended).resolves.toMatchObject({ reason: 'drain' });
  expect(observed).toHaveBeenCalledWith({ type: 'end', reason: 'drain' });
}, 60000);
it('throwing transport unsubscribe does not prevent ended', async () => {
  const h = await setup(false),
    subscribe = h.carrier.duplex.onClose;
  h.carrier.duplex.onClose = (fn) => {
    const off = subscribe(fn);
    return () => {
      off();
      throw new Error('broken unsubscribe');
    };
  };
  await h.engine.start();
  await expect(h.engine.dispose('drain')).resolves.toMatchObject({ reason: 'drain' });
  await expect(h.engine.ended).resolves.toMatchObject({ reason: 'drain' });
}, 60000);
