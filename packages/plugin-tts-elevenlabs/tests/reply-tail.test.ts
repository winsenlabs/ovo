import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { socketOpen } from '../src/testing.ts';
import { ElevenLabsTts } from '../src/tts.ts';
import { aligned, audioFrame, drain, fill, sent, ttsInput, wsScript } from './support.ts';

const live = () => new AbortController().signal;

describe('ElevenLabs reply tail audio (Wave 4 review blocker)', () => {
  // A segment's audio does not end with the frame holding its last letter: the rest of that
  // phoneme, trailing punctuation or silence, and frames without alignment can still follow.
  const rig = (steps: Parameters<typeof wsScript>[0]) => {
    const clock = new FakeClock();
    const net = createFixtureNet([wsScript([socketOpen(MULAW_8K), ...steps])], { clock });
    return { clock, net, tts: new ElevenLabsTts(net, 'fixture-key', {}, clock) };
  };
  const settles = (promise: Promise<unknown>) => {
    const state = { settled: false };
    void promise.finally(() => (state.settled = true)).catch(() => undefined);
    return state;
  };

  it('keeps a trailing punctuation frame and an unaligned frame with the last segment', async () => {
    const { clock, net, tts } = rig([
      sent('ovo-1', { text: ' ' }),
      sent('ovo-1', { text: 'Bye. ', flush: true }),
      { send: aligned('ovo-1', fill(24, 1), 'Bye', [0, 1, 2]) },
      { send: aligned('ovo-1', fill(160, 2), '. ', [0, 15]) },
      // sync_alignment off: a frame may carry no alignment at all.
      { send: audioFrame('ovo-1', fill(400, 3)) },
      sent('ovo-1', { close_context: true }),
    ]);
    const reply = await tts.openReply!(ttsInput());
    const bye = drain(reply.segment('Bye.', live()));
    const state = settles(bye);
    await clock.advanceAsync(599);
    expect(state.settled).toBe(false);
    // With every letter heard, the quiet gap is the end of the reply's last segment.
    await clock.advanceAsync(1);
    expect(await bye).toEqual([...fill(24, 1), ...fill(160, 2), ...fill(400, 3)]);
    await reply.close();
    net.assertComplete();
  });

  it('keeps unaligned audio after an alignment that already covers the whole segment', async () => {
    const { clock, net, tts } = rig([
      sent('ovo-1', { text: ' ' }),
      sent('ovo-1', { text: 'Bye now. ', flush: true }),
      { send: aligned('ovo-1', fill(24, 1), 'Bye now. ', [0, 0, 0, 1, 1, 1, 2, 2, 2]) },
      { send: audioFrame('ovo-1', fill(400, 2)) },
      sent('ovo-1', { close_context: true }),
    ]);
    const reply = await tts.openReply!(ttsInput());
    const bye = drain(reply.segment('Bye now.', live()));
    await clock.advanceAsync(600);
    expect(await bye).toEqual([...fill(24, 1), ...fill(400, 2)]);
    await reply.close();
    net.assertComplete();
  });

  it('a middle segment keeps its tail and ends the moment the next one starts', async () => {
    const { clock, net, tts } = rig([
      sent('ovo-1', { text: ' ' }),
      sent('ovo-1', { text: 'One. ', flush: true }),
      sent('ovo-1', { text: 'Two. ', flush: true }),
      { send: aligned('ovo-1', fill(8, 1), 'One', [0, 0.3, 0.6]) },
      { send: aligned('ovo-1', fill(16, 2), '. ', [0, 1]) },
      { send: audioFrame('ovo-1', fill(8, 3)) },
      // "T" starts 1 ms in (byte 8 of μ-law 8 kHz): the frame is cut there.
      { send: aligned('ovo-1', [...fill(8, 4), ...fill(8, 5)], ' Two', [0, 1, 1.3, 1.6]) },
      { send: aligned('ovo-1', fill(8, 6), '. ', [0, 0.5]) },
      { send: audioFrame('ovo-1', fill(8, 7)) },
      sent('ovo-1', { close_context: true }),
    ]);
    const reply = await tts.openReply!(ttsInput());
    const first = drain(reply.segment('One.', live()));
    const second = drain(reply.segment('Two.', live()));
    const state = settles(first);
    // No timer is needed mid-reply: the next segment's first letter ends this one.
    await clock.advanceAsync(0);
    expect(state.settled).toBe(true);
    expect(await first).toEqual([...fill(8, 1), ...fill(16, 2), ...fill(8, 3), ...fill(8, 4)]);
    await clock.advanceAsync(600);
    expect(await second).toEqual([...fill(8, 5), ...fill(8, 6), ...fill(8, 7)]);
    await reply.close();
    net.assertComplete();
  });

  it('a tail that arrives before the next segment is pushed stays with its own segment', async () => {
    const { clock, net, tts } = rig([
      sent('ovo-1', { text: ' ' }),
      sent('ovo-1', { text: 'One. ', flush: true }),
      { send: aligned('ovo-1', fill(8, 1), 'One.', [0, 0.3, 0.6, 0.9]) },
      { send: audioFrame('ovo-1', fill(16, 2)) },
      sent('ovo-1', { text: 'Two. ', flush: true }),
      { send: aligned('ovo-1', fill(8, 3), 'Two.', [0, 0.3, 0.6, 0.9]) },
      sent('ovo-1', { close_context: true }),
    ]);
    const reply = await tts.openReply!(ttsInput());
    const first = drain(reply.segment('One.', live()));
    await clock.advanceAsync(100);
    // The LLM is slower than the audio: the next sentence comes after the tail has arrived.
    const second = drain(reply.segment('Two.', live()));
    await clock.advanceAsync(0);
    expect(await first).toEqual([...fill(8, 1), ...fill(16, 2)]);
    await clock.advanceAsync(600);
    expect(await second).toEqual(fill(8, 3));
    await reply.close();
    net.assertComplete();
  });
});
