import type { AudioFormat } from '@winsendotai/ovo-contracts';
import { createTranscoder, plan, type CodecPlan } from './codec-graph.ts';
import { FrameAggregator } from './frame-aggregator.ts';
import type { ResamplerOptions } from './polyphase-resampler.ts';

export interface Reframer {
  readonly plan: CodecPlan;
  /** Bytes in `from`, any chunking → whole `frameMs` frames in `to`. The remainder waits. */
  push(bytes: Uint8Array): Uint8Array[];
  /** Drops buffered audio and resampler history, e.g. after a gap or a barge-in. */
  reset(): void;
}

/**
 * A transcode followed by a re-frame: what a media bridge needs on each direction, where the
 * carrier delivers 20 ms μ-law but a room wants fixed PCM frames at its own rate, and the room
 * delivers 10 ms PCM chunks that the carrier wants as 20 ms μ-law. The output does not depend on
 * how the input was chunked, and the resampler delay shows up only as a short first frame wait.
 */
export function createReframer(
  from: AudioFormat,
  to: AudioFormat,
  frameMs = 20,
  options: ResamplerOptions = {},
): Reframer {
  const codecPlan = plan(from, to);
  if (!codecPlan)
    throw new RangeError(
      `No conversion from ${from.encoding}@${from.sampleRate} to ${to.encoding}@${to.sampleRate}`,
    );
  let transcoder = createTranscoder(codecPlan, options);
  const frames = new FrameAggregator(to, frameMs);
  return {
    plan: codecPlan,
    push: (bytes) => frames.push(transcoder.push(bytes)),
    reset() {
      frames.reset();
      transcoder = createTranscoder(codecPlan, options);
    },
  };
}
