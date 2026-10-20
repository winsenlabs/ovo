import type { HoldPolicy } from '../types/queues';

export interface HoldSegment {
  kind: 'clip' | 'silence' | 'line';
  fromS: number;
  toS: number;
  /** 0 for the first pass; 1 and up once the sequence has looped. */
  loop: number;
  label: string;
}

export const DEFAULT_LINE_SECONDS = 4;
/** A clip whose length is not known is drawn this long and labelled so. */
export const UNKNOWN_CLIP_SECONDS = 10;

/**
 * The hold as a time axis: each step in order, then the sequence again from `loopFrom` until
 * `maxSeconds` cuts it. The last segment is clipped at the maximum; `timeoutAt` is where the
 * timeout chain starts.
 */
export function holdTimeline(
  policy: HoldPolicy,
  options: { clipSeconds?: (assetId: string) => number | undefined; lineSeconds?: number } = {},
): { segments: HoldSegment[]; maxSeconds: number; timeoutAt: number } {
  const lineSeconds = options.lineSeconds ?? DEFAULT_LINE_SECONDS;
  const lengthOf = (step: HoldPolicy['steps'][number]) => {
    if (step.kind === 'silence') return step.seconds;
    if (step.kind === 'line') return lineSeconds;
    const known = options.clipSeconds?.(step.assetId);
    const whole = known ?? UNKNOWN_CLIP_SECONDS;
    return step.maxSeconds ? Math.min(whole, step.maxSeconds) : whole;
  };
  const labelOf = (step: HoldPolicy['steps'][number]) =>
    step.kind === 'silence'
      ? 'Silence'
      : step.kind === 'line'
        ? 'Spoken line'
        : options.clipSeconds?.(step.assetId) === undefined
          ? 'Clip (length unknown)'
          : 'Clip';
  const segments: HoldSegment[] = [];
  const max = policy.maxSeconds;
  const start = Math.min(Math.max(policy.loopFrom, 0), Math.max(policy.steps.length - 1, 0));
  let at = 0;
  let loop = 0;
  let index = 0;
  // A loop of zero-length steps would never advance; the guard bounds it by steps and passes.
  for (let guard = 0; at < max && guard < 500 && policy.steps.length; guard += 1) {
    const step = policy.steps[index]!;
    const length = Math.max(lengthOf(step), 0);
    if (length > 0)
      segments.push({
        kind: step.kind,
        fromS: at,
        toS: Math.min(at + length, max),
        loop,
        label: labelOf(step),
      });
    at += length;
    index += 1;
    if (index >= policy.steps.length) {
      index = start;
      loop += 1;
    }
  }
  return { segments, maxSeconds: max, timeoutAt: max };
}
