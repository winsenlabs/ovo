import { MULAW_8K, PCM16_8K, type HoldPolicy } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { HoldPlayer, lineFor } from '../src/hold-player.ts';
import { SegmentMediaLease } from '../src/segment-media.ts';
import { fakeMediaLink } from './segment-fixtures.ts';
import { FakeClock, flush } from './transfer-fixtures.ts';

const SHA = 'a'.repeat(64);

function player(
  steps: HoldPolicy['steps'],
  options: {
    loopFrom?: number;
    clip?: Uint8Array;
    voice?: (text: string) => Promise<Uint8Array>;
    format?: typeof MULAW_8K;
  } = {},
) {
  const link = fakeMediaLink();
  const sent: Uint8Array[] = [];
  (link as { sendAudio(audio: Uint8Array): Promise<void> }).sendAudio = async (audio) =>
    void sent.push(audio);
  const clock = new FakeClock();
  const audits: [string, Record<string, unknown>][] = [];
  const lease = new SegmentMediaLease(link, { format: MULAW_8K, live: true });
  const render = vi.fn(async (text: string) =>
    options.voice ? options.voice(text) : new Uint8Array(),
  );
  const clips = { get: vi.fn(async () => options.clip) };
  const hold = new HoldPlayer({
    media: lease,
    format: options.format ?? MULAW_8K,
    policy: {
      steps,
      loopFrom: options.loopFrom ?? 0,
      maxSeconds: 60,
      waitForCapacity: false,
      onTimeout: [{ kind: 'default' }],
    },
    language: { call: 'hi', default: 'en' },
    clips,
    voice: { render, close: async () => undefined },
    audit: (type, payload) => audits.push([type, payload]),
    tags: { transfer: 2 },
    clock,
  });
  return { hold, link, sent, clock, audits, render, clips, lease };
}

describe('HoldPlayer (transfer design 7.6)', () => {
  it('plays a clip in 20 ms frames, at most 300 ms ahead, cut at its maxSeconds', async () => {
    const clip = new Uint8Array(8_000 * 3).fill(9);
    const h = player([{ kind: 'clip', assetId: 'clip-1', sha256: SHA, maxSeconds: 2 }], { clip });
    h.hold.start('target');
    await flush();
    // 300 ms of look-ahead plus the frame due now: 16 frames of 160 bytes before any wait.
    expect(h.sent.map((frame) => frame.byteLength)).toEqual(Array(16).fill(160));
    await h.clock.advance(1_700);
    expect(h.sent.length).toBe(100);
    expect(h.clips.get).toHaveBeenCalledWith('clip-1', SHA);
    await h.clock.advance(400);
    // Cut at 2 s: the loop starts the clip again only once the first pass has played out.
    expect(h.sent.length).toBeGreaterThan(100);
    expect(h.audits[0]).toEqual(['transfer.hold.started', { transfer: 2, policy: 'target' }]);
    await h.hold.stop('target_audio');
  });

  it('keeps silence and the step order, and loops from loopFrom', async () => {
    const clip = new Uint8Array(160).fill(1);
    const h = player(
      [
        { kind: 'silence', seconds: 2 },
        { kind: 'clip', assetId: 'a', sha256: SHA },
        { kind: 'line', line: { en: 'Thanks for holding.', hi: 'होल्ड करने के लिए धन्यवाद।' } },
      ],
      { clip, loopFrom: 1, voice: async () => new Uint8Array(320).fill(2) },
    );
    h.hold.start('point');
    await flush();
    expect(h.sent).toEqual([]);
    await h.clock.advance(2_000);
    await h.clock.advance(100);
    // The line is spoken in the call's language through the house voice, once per hold.
    expect(h.render).toHaveBeenCalledWith(
      'होल्ड करने के लिए धन्यवाद।',
      'hi',
      expect.any(AbortSignal),
    );
    const bytes = () => h.sent.map((frame) => frame[0]);
    expect(bytes().slice(0, 3)).toEqual([1, 2, 2]);
    await h.clock.advance(100);
    // From loopFrom (the clip), never the silence again.
    expect(bytes().slice(0, 6)).toEqual([1, 2, 2, 1, 2, 2]);
    expect(h.render).toHaveBeenCalledOnce();
    await h.hold.stop('target_audio');
  });

  it('skips a missing clip and a line it cannot render, audited once each', async () => {
    const h = player(
      [
        { kind: 'clip', assetId: 'gone', sha256: SHA },
        { kind: 'line', line: { en: 'Hold on.' } },
      ],
      { voice: async () => Promise.reject(new Error('tts down')) },
    );
    h.hold.start('default');
    await h.clock.advance(5_000);
    expect(h.sent).toEqual([]);
    expect(h.audits.map(([type]) => type)).toEqual([
      'transfer.hold.started',
      'transfer.hold.clip_missing',
      'transfer.hold.line_failed',
    ]);
    await h.hold.stop('target_audio');
  });

  it('stop clears what the carrier holds, releases its lease, and is idempotent', async () => {
    const h = player([{ kind: 'clip', assetId: 'a', sha256: SHA }], {
      clip: new Uint8Array(1_600),
    });
    h.hold.start('point');
    await flush();
    await Promise.all([h.hold.stop('target_audio'), h.hold.stop('caller_hangup')]);
    expect(h.link.sent).toEqual(['clear']);
    expect(h.lease.released).toBe(true);
    const stopped = h.audits.filter(([type]) => type === 'transfer.hold.stopped');
    expect(stopped).toEqual([
      ['transfer.hold.stopped', { transfer: 2, ms: 0, why: 'target_audio' }],
    ]);
    await h.clock.advance(1_000);
    expect(h.sent.length).toBe(10);
  });

  it('say replaces the sequence with one line, played out in full', async () => {
    const h = player([{ kind: 'silence', seconds: 60 }], {
      voice: async () => new Uint8Array(1_600).fill(5),
    });
    h.hold.start('point');
    const said = h.hold.say({ en: 'Goodbye.' }, 'timeout_chain');
    await flush();
    let done = false;
    void said.then(() => (done = true));
    await h.clock.advance(100);
    expect(done).toBe(false);
    await h.clock.advance(100);
    expect(done).toBe(true);
    expect(h.sent.map((frame) => frame[0])).toEqual(Array(10).fill(5));
    expect(h.lease.released).toBe(true);
  });

  it('converts a stored mu-law clip for a PCM carrier leg', async () => {
    const h = player([{ kind: 'clip', assetId: 'a', sha256: SHA }], {
      clip: new Uint8Array(160).fill(0xff),
      format: PCM16_8K,
    });
    h.hold.start('point');
    await flush();
    expect(h.sent.map((frame) => frame.byteLength)).toEqual([320]);
    await h.hold.stop('target_audio');
  });

  it('picks the call language, then the default, then English, then the first line', () => {
    expect(lineFor({ en: 'Hi', hi: 'नमस्ते' }, 'hi', 'en')).toEqual({
      text: 'नमस्ते',
      language: 'hi',
    });
    expect(lineFor({ en: 'Hi', ta: 'வணக்கம்' }, 'hi', 'ta')).toEqual({
      text: 'வணக்கம்',
      language: 'ta',
    });
    expect(lineFor({ en: 'Hi' }, 'hi', 'ta')).toEqual({ text: 'Hi', language: 'en' });
    expect(lineFor({ mr: 'नमस्कार' }, 'hi', 'en')).toEqual({ text: 'नमस्कार', language: 'mr' });
  });
});
