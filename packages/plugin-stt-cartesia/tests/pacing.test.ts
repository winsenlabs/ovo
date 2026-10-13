import { msForBytes, silence } from '@winsendotai/ovo-audio';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { MULAW_8K, PCM16_16K } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { BacklogPacer, KEEPER_GAP_MS, KEEPER_TICK_MS, SilenceKeeper } from '../src/pacing.ts';
import type { UplinkItem } from '../src/pacing.ts';

describe('SilenceKeeper (C6)', () => {
  it('feeds the gap after 200 ms without a write, then 100 ms per tick until audio returns', () => {
    const clock = new FakeClock();
    const fed: number[] = [];
    const keeper = new SilenceKeeper(clock, (ms) => fed.push(ms));
    clock.advance(KEEPER_GAP_MS - 1);
    expect(fed).toEqual([]);
    clock.advance(1);
    expect(fed).toEqual([200]);
    clock.advance(KEEPER_TICK_MS * 3);
    expect(fed).toEqual([200, 100, 100, 100]);
    keeper.touch();
    clock.advance(KEEPER_GAP_MS - 1);
    expect(fed).toHaveLength(4);
    clock.advance(1);
    expect(fed).toEqual([200, 100, 100, 100, 200]);
    keeper.stop();
    clock.advance(10_000);
    expect(fed).toHaveLength(5);
  });

  it('never fires while writes keep arriving within the gap', () => {
    const clock = new FakeClock();
    const fed: number[] = [];
    const keeper = new SilenceKeeper(clock, (ms) => fed.push(ms));
    for (let i = 0; i < 50; i += 1) {
      clock.advance(100);
      keeper.touch();
    }
    expect(fed).toEqual([]);
    keeper.stop();
  });

  it('feeds at most one second after a stalled event loop, not the whole stall', () => {
    let now = 0;
    let due: (() => void) | undefined;
    const fed: number[] = [];
    const keeper = new SilenceKeeper(
      {
        now: () => now,
        setTimeout: (fn) => {
          due = fn;
          return () => (due = undefined);
        },
      },
      (ms) => fed.push(ms),
    );
    now = 7_000;
    due!();
    expect(fed).toEqual([1_000]);
    keeper.stop();
  });

  it('μ-law silence is 0xFF and PCM16 silence is zero, as the keeper writes it', () => {
    expect([...silence(MULAW_8K, 1)]).toEqual(new Array(8).fill(0xff));
    expect([...silence(PCM16_16K, 1)]).toEqual(new Array(32).fill(0));
  });
});

describe('BacklogPacer (C6)', () => {
  const frame = (ms: number) => new Uint8Array(ms * 8);

  it('replays a 15 s pre-session backlog at no more than 2x real time', () => {
    const clock = new FakeClock();
    const sentAt: { at: number; ms: number }[] = [];
    const pacer = new BacklogPacer(
      clock,
      MULAW_8K,
      (item) =>
        sentAt.push({ at: clock.now(), ms: 'audio' in item ? item.audio.byteLength / 8 : 0 }),
      2,
      100,
    );
    for (let i = 0; i < 150; i += 1) pacer.push({ audio: frame(100) });
    expect(sentAt).toHaveLength(1);
    expect(pacer.queuedMs).toBe(14_900);
    clock.advance(20_000);
    expect(sentAt).toHaveLength(150);
    // Over any window from the start, audio sent ≤ one frame of headroom + 2x the time elapsed.
    let total = 0;
    for (const { at, ms } of sentAt) {
      total += ms;
      expect(total).toBeLessThanOrEqual(100 + 2 * at + 1e-6);
    }
    // 15 s at 2x is 7.45 s after the first frame went out at once.
    expect(sentAt.at(-1)!.at).toBe(7_450);
  });

  it('lets live audio (one 100 ms frame per 100 ms) through without waiting', () => {
    const clock = new FakeClock();
    const sentAt: number[] = [];
    const pacer = new BacklogPacer(clock, MULAW_8K, () => sentAt.push(clock.now()), 2, 100);
    for (let i = 0; i < 20; i += 1) {
      pacer.push({ audio: frame(100) });
      expect(sentAt.at(-1)).toBe(clock.now());
      clock.advance(100);
    }
    expect(sentAt).toHaveLength(20);
  });

  it('queues a text command behind the audio before it and resolves drained() after both', async () => {
    const clock = new FakeClock();
    const sent: UplinkItem[] = [];
    const pacer = new BacklogPacer(clock, MULAW_8K, (item) => sent.push(item), 2, 100);
    pacer.push({ audio: frame(100) });
    pacer.push({ audio: frame(100) });
    pacer.push({ text: 'finalize' });
    let drained = false;
    void pacer.drained().then(() => (drained = true));
    expect(sent.map((item) => ('text' in item ? item.text : 'audio'))).toEqual(['audio']);
    await clock.advanceAsync(50);
    expect(sent.map((item) => ('text' in item ? item.text : 'audio'))).toEqual([
      'audio',
      'audio',
      'finalize',
    ]);
    expect(drained).toBe(true);
  });

  it('stop() drops the queue and releases drained() waiters', async () => {
    const clock = new FakeClock();
    const sent: UplinkItem[] = [];
    const pacer = new BacklogPacer(clock, MULAW_8K, (item) => sent.push(item), 2, 100);
    for (let i = 0; i < 10; i += 1) pacer.push({ audio: frame(100) });
    const drained = pacer.drained();
    pacer.stop();
    await drained;
    clock.advance(10_000);
    expect(sent).toHaveLength(1);
    pacer.push({ audio: frame(100) });
    expect(sent).toHaveLength(1);
    expect(msForBytes(MULAW_8K, 800)).toBe(100);
  });
});
