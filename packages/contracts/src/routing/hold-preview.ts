import type { HoldPolicy } from './transfer.ts';

/** One stretch of a hold on a time axis. */
export interface HoldSegment {
  kind: 'clip' | 'silence' | 'line';
  fromS: number;
  toS: number;
  /** 0 on the first pass, +1 each time the sequence loops back to `loopFrom`. */
  loop: number;
  label: string;
  /** Set on a clip whose real length is not known; it is drawn `DEFAULT_CLIP_SECONDS` long. */
  lengthUnknown?: true;
}

export interface HoldTimelineOptions {
  /** Real duration of an uploaded clip, in seconds. Unknown clips read as `DEFAULT_CLIP_SECONDS`. */
  clipSeconds?: (assetId: string) => number | undefined;
  /** A clip's display name. */
  clipName?: (assetId: string) => string | undefined;
  /** How long a reassurance line takes to say. Default 4. */
  lineSeconds?: number;
}

export const DEFAULT_CLIP_SECONDS = 10;
export const DEFAULT_LINE_SECONDS = 4;
/** A hold of one-second steps and a 900 s cap is 900 segments at the very most; bound the preview anyway. */
const MAX_SEGMENTS = 1_000;

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

function lineText(line: Record<string, string>): string {
  const text = line.en ?? Object.values(line)[0] ?? '';
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * The hold as a time axis: the steps in order, then the sequence again from `loopFrom`, until
 * `maxSeconds` (the last segment is cut there). `timeoutAt` is when the `onTimeout` chain starts.
 */
export function holdTimeline(
  policy: Pick<HoldPolicy, 'steps' | 'loopFrom' | 'maxSeconds'>,
  options: HoldTimelineOptions = {},
): { segments: HoldSegment[]; maxSeconds: number; timeoutAt: number } {
  const lineSeconds = options.lineSeconds ?? DEFAULT_LINE_SECONDS;
  const durations = policy.steps.map((step) => {
    if (step.kind === 'silence') return step.seconds;
    if (step.kind === 'line') return lineSeconds;
    const whole = options.clipSeconds?.(step.assetId) ?? DEFAULT_CLIP_SECONDS;
    return step.maxSeconds === undefined ? whole : Math.min(whole, step.maxSeconds);
  });
  const loopFrom = policy.loopFrom < policy.steps.length ? policy.loopFrom : 0;
  const segments: HoldSegment[] = [];
  let at = 0;
  let loop = 0;
  let index = 0;
  while (at < policy.maxSeconds && segments.length < MAX_SEGMENTS && policy.steps.length > 0) {
    const step = policy.steps[index]!;
    const length = Math.max(durations[index]!, 0.1);
    const toS = Math.min(at + length, policy.maxSeconds);
    const label =
      step.kind === 'silence'
        ? 'Silence'
        : step.kind === 'line'
          ? `Line: ${lineText(step.line)}`
          : `Clip: ${options.clipName?.(step.assetId) ?? step.assetId.slice(0, 8)}`;
    const lengthUnknown = step.kind === 'clip' && options.clipSeconds?.(step.assetId) === undefined;
    segments.push({
      kind: step.kind,
      fromS: round(at),
      toS: round(toS),
      loop,
      label,
      ...(lengthUnknown ? { lengthUnknown: true as const } : {}),
    });
    at = toS;
    index += 1;
    if (index >= policy.steps.length) {
      index = loopFrom;
      loop += 1;
    }
  }
  return { segments, maxSeconds: policy.maxSeconds, timeoutAt: policy.maxSeconds };
}
