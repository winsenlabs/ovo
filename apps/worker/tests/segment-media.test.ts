import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { SegmentMediaLease } from '../src/segment-media.ts';
import { fakeMediaLink } from './segment-fixtures.ts';

const frame = (byte: number, size = 160) => new Uint8Array(size).fill(byte);

describe('SegmentMediaLease (routing design 7.4)', () => {
  it('drops its link subscriptions and every engine listener on release', async () => {
    const link = fakeMediaLink();
    const lease = new SegmentMediaLease(link, { format: MULAW_8K });
    expect(link.listenerCount()).toBe(4);
    const heard: string[] = [];
    lease.onAudio(() => heard.push('audio'));
    lease.onDtmf((digit) => heard.push(`dtmf:${digit}`));
    lease.onMark((name) => heard.push(`mark:${name}`));
    lease.onClose((reason) => heard.push(`close:${reason}`));
    link.audio(frame(1));
    link.dtmf('5');
    link.mark('m1');
    expect(heard).toEqual(['audio', 'dtmf:5', 'mark:m1']);

    lease.release();
    lease.release();
    expect(link.listenerCount()).toBe(0);
    link.audio(frame(2));
    link.dtmf('6');
    link.hangup('caller_hangup');
    expect(heard).toEqual(['audio', 'dtmf:5', 'mark:m1']);
    await expect(lease.sendAudio(frame(3))).rejects.toThrow('segment media lease is released');
    await expect(lease.sendMark('m2')).rejects.toThrow('released');
    await lease.clear();
    await lease.close('behavior_completed');
    expect(link.sent).toEqual([]);
    expect(link.closed).toEqual([]);
    // A listener added after release is never called and its unsubscribe is harmless.
    lease.onAudio(() => heard.push('late'))();
  });

  it('keeps the link open only while the call is handing off', async () => {
    const link = fakeMediaLink();
    let handingOff = false;
    const interceptClose = vi.fn(() => handingOff);
    const lease = new SegmentMediaLease(link, { format: MULAW_8K, interceptClose });
    await lease.close('behavior_completed');
    expect(link.closed).toEqual(['behavior_completed']);

    const next = fakeMediaLink();
    const committed = new SegmentMediaLease(next, { format: MULAW_8K, interceptClose });
    handingOff = true;
    await committed.close('behavior_completed');
    expect(interceptClose).toHaveBeenLastCalledWith('behavior_completed');
    expect(next.closed).toEqual([]);
  });

  it('holds a prepared segment deaf and mute until the gap starts', async () => {
    const link = fakeMediaLink();
    const lease = new SegmentMediaLease(link, { format: MULAW_8K, live: false });
    const heard: number[] = [];
    lease.onAudio((bytes) => heard.push(bytes[0]!));
    link.audio(frame(1));
    link.mark('router-line');
    await expect(lease.sendAudio(frame(9))).rejects.toThrow('segment media lease is held');
    lease.buffer();
    link.audio(frame(2));
    await lease.sendAudio(frame(9));
    lease.open();
    link.audio(frame(3));
    expect(heard).toEqual([2, 3]);
    expect(link.sent).toEqual(['audio']);
  });

  it('replays the gap in order before live input and counts audio dropped past two seconds', () => {
    const link = fakeMediaLink();
    const lease = new SegmentMediaLease(link, { format: MULAW_8K, live: false });
    const heard: string[] = [];
    lease.onAudio((bytes, at) => heard.push(`a${bytes[0]}@${at}`));
    lease.onDtmf((digit) => heard.push(`d${digit}`));
    lease.onMark((name) => heard.push(`m:${name}`));
    lease.buffer();
    // 8 kHz mu-law: 8000 bytes a second, so 2 s is 16000 bytes; 2.5 s arrive in 500 ms frames.
    for (let index = 0; index < 5; index++) {
      link.audio(frame(index, 4_000), index * 500);
      if (index === 1) link.dtmf('2');
    }
    link.mark('agent-opening');
    expect(heard).toEqual(['m:agent-opening']);
    expect(lease.gapDropped).toEqual({ ms: 500, digits: 0 });
    lease.open();
    link.audio(frame(9), 3_000);
    expect(heard).toEqual([
      ...['m:agent-opening', 'a1@500', 'd2', 'a2@1000', 'a3@1500', 'a4@2000'],
      'a9@3000',
    ]);
  });

  it('bounds the keypresses it holds', () => {
    const link = fakeMediaLink();
    const lease = new SegmentMediaLease(link, { format: MULAW_8K, live: false });
    const digits: string[] = [];
    lease.onDtmf((digit) => digits.push(digit));
    lease.buffer();
    for (let index = 0; index < 40; index++) link.dtmf(String(index % 10));
    lease.open();
    expect(digits).toHaveLength(32);
    expect(lease.gapDropped.digits).toBe(8);
  });
});
