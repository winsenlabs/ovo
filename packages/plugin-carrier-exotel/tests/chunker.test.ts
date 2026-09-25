import { describe, expect, it } from 'vitest';
import { ExotelChunker, exotelMediaSerializer } from '../src/index.ts';

const start = () =>
  JSON.stringify({
    event: 'start',
    stream_sid: 'stream-1',
    start: {
      stream_sid: 'stream-1',
      call_sid: 'call-1',
      media_format: { encoding: 'raw', sample_rate: '8000' },
    },
  });
const audioBytes = (frames: readonly string[]): Uint8Array[] =>
  frames.map(
    (frame) =>
      new Uint8Array(
        Buffer.from((JSON.parse(frame) as { media: { payload: string } }).media.payload, 'base64'),
      ),
  );

describe('Exotel chunk framing', () => {
  it('carries short audio and pads on flush or mark', () => {
    const chunker = new ExotelChunker();
    expect(chunker.push(new Uint8Array(1000))).toEqual([]);
    expect(chunker.remainderBytes).toBe(1000);
    const padded = chunker.flush();
    expect(padded).toHaveLength(1);
    expect(padded[0]?.byteLength).toBe(3200);
    expect(padded[0]?.slice(1000).every((byte) => byte === 0)).toBe(true);
    const codec = exotelMediaSerializer.createSession({});
    codec.decode(start());
    expect(codec.encode({ type: 'audio', payload: new Uint8Array(1000) })).toEqual([]);
    const frames = codec.encode({ type: 'mark', name: 'last' });
    expect(audioBytes(frames.slice(0, 1))[0]?.byteLength).toBe(3200);
    expect(JSON.parse(frames[1]!).event).toBe('mark');
  });

  it('accumulates seven 160-byte inputs and splits a >100 KB payload', () => {
    const chunker = new ExotelChunker();
    for (let i = 0; i < 7; i++) expect(chunker.push(new Uint8Array(160))).toEqual([]);
    expect(chunker.remainderBytes).toBe(1120);
    expect(chunker.flush()[0]?.byteLength).toBe(3200);
    const large = chunker.push(new Uint8Array(205120));
    expect(large.map((item) => item.byteLength)).toEqual([102400, 102400]);
    expect(chunker.remainderBytes).toBe(320);
    expect(chunker.flush()[0]?.byteLength).toBe(3200);
  });

  it('discards the remainder on clear instead of playing stale speech', () => {
    const codec = exotelMediaSerializer.createSession({});
    codec.decode(start());
    codec.encode({ type: 'audio', payload: new Uint8Array(1000) });
    expect(JSON.parse(codec.encode({ type: 'clear' })[0]!).event).toBe('clear');
    expect(codec.flush()).toEqual([]);
  });
});
