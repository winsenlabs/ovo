import { expect, it } from 'vitest';
import { PCM16_8K, MULAW_8K } from '@winsendotai/ovo-contracts';
import { withEgressSentinel } from '@winsendotai/ovo-conformance/drivers';
it('preserves arbitrary and odd PCM byte chunks as 20 ms LiveKit frames without resampling', async () => {
  await withEgressSentinel(
    async (sentinel) => {
      const { FrameDecoder, encode } = await import('../src/codec.ts');
      const bytes = Uint8Array.from({ length: 963 }, (_, i) => i % 251);
      const decoder = new FrameDecoder(PCM16_8K);
      const frames = [
        ...decoder.push(bytes.slice(0, 1)),
        ...decoder.push(bytes.slice(1, 11)),
        ...decoder.push(bytes.slice(11, 700)),
        ...decoder.push(bytes.slice(700, 962)),
        ...decoder.finish(),
      ];
      expect(frames.map((frame) => frame.samplesPerChannel)).toEqual([160, 160, 160, 1]);
      expect(new Uint8Array(frames.flatMap((frame) => [...encode(frame, PCM16_8K)]))).toEqual(
        bytes.slice(0, 962),
      );
      const mulaw = new FrameDecoder(MULAW_8K);
      expect(mulaw.push(new Uint8Array(320))).toHaveLength(2);
      expect(sentinel.attempts).toEqual([]);
    },
    { allowLoopback: false },
  );
});
