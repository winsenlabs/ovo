import type { VadParams } from '@winsendotai/ovo-contracts';

export type VadTransition = { type: 'vad.start' | 'vad.stop'; atMs: number; frame: number };
export type VadPhase = 'QUIET' | 'STARTING' | 'SPEAKING' | 'STOPPING';

/** State transitions are counted in whole 20 ms frames, never wall timers. */
export class VadState {
  phase: VadPhase = 'QUIET';
  private consecutive = 0;
  private frame = 0;
  private readonly startFrames: number;
  private readonly stopFrames: number;

  constructor(private readonly params: VadParams, private readonly frameMs = 20) {
    this.startFrames = Math.max(1, Math.round(params.startMs / frameMs));
    this.stopFrames = Math.max(1, Math.round(params.stopMs / frameMs));
  }

  observe(confidence: number, volume: number): VadTransition | undefined {
    const frame = this.frame++;
    const speaking = confidence >= this.params.confidence && volume >= this.params.minVolume;
    if (this.phase === 'QUIET' || this.phase === 'STARTING') {
      if (!speaking) { this.phase = 'QUIET'; this.consecutive = 0; return; }
      this.phase = 'STARTING';
      if (++this.consecutive < this.startFrames) return;
      this.phase = 'SPEAKING'; this.consecutive = 0;
      return { type: 'vad.start', atMs: frame * this.frameMs, frame };
    }
    if (speaking) { this.phase = 'SPEAKING'; this.consecutive = 0; return; }
    this.phase = 'STOPPING';
    if (++this.consecutive < this.stopFrames) return;
    this.phase = 'QUIET'; this.consecutive = 0;
    return { type: 'vad.stop', atMs: frame * this.frameMs, frame };
  }

  reset(): void { this.phase = 'QUIET'; this.consecutive = 0; this.frame = 0; }
}
