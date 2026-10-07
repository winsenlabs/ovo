import { describe, expect, it } from 'vitest';
import { Cap, type Behavior, type Inference } from '@winsendotai/ovo-contracts';
import { ActivityListeners, type InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { createNativeVoiceEngineV2Plugin } from '../src/engine/plugin.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { sleep } from './turn-harness.ts';

const LINE = 'Let me look that up.';

/** The session's LLM as the engine sees it: a port that reports the searches it runs (N3). */
function searchingLlm() {
  const listeners = new ActivityListeners();
  const inference = Object.assign(listeners, {
    generate: async () => ({ kind: 'text' as const, text: '' }),
  }) as Inference & ActivityListeners;
  const started = (): InferenceActivity => ({
    phase: 'started',
    tool: 'web_search',
    id: 'ws-1',
    atMs: 0,
    signal: new AbortController().signal,
    announce: { line: LINE, stillAfterMs: 2500 },
  });
  return { inference, search: () => listeners.emit(started()) };
}

describe('the engine hears the LLM start a web search (N3)', () => {
  it('says the search line while the reply is still being composed', async () => {
    const clock = new FakeClock();
    const carrier = createFakeCarrier({ clock });
    const spoken: string[] = [];
    const llm = searchingLlm();
    const behavior: Behavior = {
      respond: async () => '',
      async *respondStream() {
        await sleep(clock, 4000);
        yield 'Zagreb is about two degrees in December.';
      },
      speaksFirst: () => true,
    };
    const engine = new NativeVoiceSessionEngine({
      clock,
      media: carrier.duplex,
      behavior,
      inference: llm.inference,
      scheduler: new BoundedSpeechScheduler({
        async play(segment) {
          spoken.push(segment.text);
          return { state: 'completed', evidence: 'confirmed' };
        },
        async interrupt() {},
      }),
      session: {
        mode: 'agent',
        language: 'en-IN',
        inputEnabled: false,
        variables: {},
        maxCallSeconds: 600,
        acknowledgements: [],
      },
    });
    void engine.start();
    await clock.advanceAsync(1200);
    llm.search();
    await clock.advanceAsync(5000);
    expect(spoken).toEqual([LINE, 'Zagreb is about two degrees in December.']);
    await engine.dispose('drain');
    // Disposed, the engine no longer listens.
    llm.search();
    expect(spoken).toHaveLength(2);
  });

  it('declares the LLM as an optional port it only observes', () => {
    const keys = manifestKeys(createNativeVoiceEngineV2Plugin().manifest);
    expect(keys.optional.map((entry) => entry.key)).toContain(Cap.inference);
    expect(keys.requires.map((entry) => entry.key)).not.toContain(Cap.inference);
  });
});
