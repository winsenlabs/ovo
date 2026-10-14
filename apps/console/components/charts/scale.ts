// Hand-rolled linear/time/band scales + "nice" tick selection. No charting library: see the
// component inventory note in /tmp/ovo-ui/components.md for why.
export type Scale = (value: number) => number;

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function timeScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  return linearScale(domain, range);
}

/** Evenly spaced band centres for `n` categories across `range`, with per-band width. */
export function bandScale(
  count: number,
  range: readonly [number, number],
  paddingRatio = 0.2,
): { center: (index: number) => number; bandwidth: number } {
  const total = range[1] - range[0];
  const step = count > 0 ? total / count : total;
  const bandwidth = step * (1 - paddingRatio);
  return {
    center: (index) => range[0] + step * (index + 0.5),
    bandwidth,
  };
}

/** "Nice" tick values covering `domain`, close to `targetCount` ticks (d3-style 1/2/5 stepping). */
export function niceTicks(domain: readonly [number, number], targetCount = 5): number[] {
  const [min, max] = domain;
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step)
    ticks.push(Math.round(value * 1e9) / 1e9);
  return ticks;
}

export function formatMsAxis(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(ms % 60000 === 0 ? 0 : 1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatInrAxis(paise: number): string {
  const rupees = paise / 100;
  if (Math.abs(rupees) >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (Math.abs(rupees) >= 1000) return `₹${(rupees / 1000).toFixed(1)}k`;
  return `₹${Math.round(rupees)}`;
}

export const CHART_PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const;
