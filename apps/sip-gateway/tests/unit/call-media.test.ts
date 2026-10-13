import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CallHost } from '../../src/call/host.ts';
import { CallMedia, MEDIA_TIMEOUT_MS, TERMINATE_DRAIN_MS } from '../../src/call/media.ts';
import type { RtpPair } from '../../src/rtp/socket-pool.ts';
import type { MediaChoice } from '../../src/sdp/negotiate.ts';
import { Counters } from '../../src/telemetry.ts';
import { FakeClock } from '../support/fake-clock.ts';
import { recordingLogger } from '../support/harness.ts';

class FakeSocket extends EventEmitter {
  readonly sent: Buffer[] = [];
  send(bytes: Buffer) {
    this.sent.push(bytes);
  }
  close() {}
}

function media(direction: MediaChoice['direction'] = 'sendrecv') {
  const clock = new FakeClock(0);
  const pair = { port: 40000, rtp: new FakeSocket(), rtcp: new FakeSocket() };
  const ended: string[] = [];
  const host = {
    clock,
    config: { advertisedHost: '127.0.0.1' },
    counters: new Counters(),
    logger: recordingLogger(),
    pool: { release: () => undefined },
  } as unknown as CallHost;
  const instance = new CallMedia(host, {
    callId: 'c1',
    carrierId: 'sip',
    bindingId: 'b1',
    pair: pair as unknown as RtpPair,
    choice: {
      codec: 'PCMU',
      pt: 0,
      remote: { address: '127.0.0.1', port: 20000 },
      direction,
      index: 0,
    },
    mediaCidrs: () => true,
    grant: {
      mediaUrl: 'wss://ovo.example.test/carriers/sip/b1/media',
      routeParams: { sid: 's', rt: 'r' },
    },
    onEnd: (reason) => {
      ended.push(reason);
      instance.stop('stream-ended');
    },
  });
  const frame = (event: Record<string, unknown>) =>
    (instance as unknown as { onFrame(f: unknown): void }).onFrame(event);
  return { clock, pair, ended, instance, frame };
}

describe('call media (§4.4, §4.5)', () => {
  it('sends one RTP frame every 20 ms, silence when nothing is queued', () => {
    const { clock, pair, instance } = media();
    instance.start();
    clock.advance(1_000);
    expect(pair.rtp.sent).toHaveLength(50);
    expect(pair.rtp.sent.every((p) => p.length === 172 && p[12] === 0xff)).toBe(true);
  });

  it('ends the call after 30 s without RTP, unless the call is on hold', () => {
    const live = media();
    live.instance.start();
    live.clock.advance(MEDIA_TIMEOUT_MS + 100);
    expect(live.ended).toEqual(['media_timeout']);
    const held = media('sendonly');
    held.instance.start();
    held.clock.advance(MEDIA_TIMEOUT_MS * 2);
    expect(held.ended).toEqual([]);
  });

  it('caps the terminate drain at 5 s and ends at once when the queue is empty', () => {
    const busy = media();
    busy.instance.start();
    busy.frame({ event: 'media', payload: Buffer.alloc(8000 * 20, 0x11).toString('base64') });
    busy.frame({ event: 'terminate' });
    busy.clock.advance(TERMINATE_DRAIN_MS - 100);
    expect(busy.ended).toEqual([]);
    busy.clock.advance(200);
    expect(busy.ended).toEqual(['terminate']);
    const idle = media();
    idle.instance.start();
    idle.frame({ event: 'terminate' });
    idle.clock.advance(20);
    expect(idle.ended).toEqual(['terminate']);
  });

  it('ends the call when playout would exceed 30 s of audio', () => {
    const { ended, frame } = media();
    frame({ event: 'media', payload: Buffer.alloc(8000 * 29, 0x11).toString('base64') });
    frame({ event: 'media', payload: Buffer.alloc(8000 * 2, 0x11).toString('base64') });
    expect(ended).toEqual(['playout_overflow']);
  });

  it('stops pacing and closes RTP once', () => {
    const { clock, pair, instance } = media();
    instance.start();
    clock.advance(100);
    const stats = instance.stop('caller-hangup');
    expect(stats.packetsOut).toBe(5);
    const sent = pair.rtp.sent.length;
    clock.advance(1_000);
    expect(pair.rtp.sent).toHaveLength(sent);
    // RTCP BYE went out on teardown.
    expect(pair.rtcp.sent.at(-1)!.includes(203)).toBe(true);
  });
});
