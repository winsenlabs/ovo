import { describe, expect, it } from 'vitest';
import {
  alawToMulaw,
  alawToPcm16,
  mulawToAlaw,
  mulawToPcm16,
  pcm16ToAlaw,
  pcm16ToMulaw,
} from '../src/index.ts';

const every = Uint8Array.from({ length: 256 }, (_, i) => i);

describe('A-law ↔ μ-law transcoding', () => {
  it('matches decode-then-encode for every code', () => {
    expect(alawToMulaw(every)).toEqual(pcm16ToMulaw(alawToPcm16(every)));
    expect(mulawToAlaw(every)).toEqual(pcm16ToAlaw(mulawToPcm16(every)));
  });

  it('keeps codec silence (near) silent', () => {
    // A-law has no exact zero: 0xD5 decodes to +8, which μ-law codes as 0xFE.
    expect(Math.abs(mulawToPcm16(alawToMulaw(Uint8Array.of(0xd5)))[0]!)).toBeLessThanOrEqual(8);
    expect([...mulawToAlaw(Uint8Array.of(0xff))]).toEqual([0xd5]);
  });

  it('round-trips within one quantisation step', () => {
    const back = mulawToPcm16(alawToMulaw(mulawToAlaw(every)));
    const original = mulawToPcm16(every);
    for (let i = 0; i < 256; i += 1)
      expect(Math.abs(back[i]! - original[i]!)).toBeLessThanOrEqual(
        Math.max(16, Math.abs(original[i]!) / 8),
      );
  });
});
