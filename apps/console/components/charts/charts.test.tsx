import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartFrame } from './chart-frame';
import { LineChart } from './line-chart';
import { BarChart } from './bar-chart';
import { Donut } from './donut';
import { Waterfall } from './waterfall';
import { ProgressMeter } from './meter';

afterEach(() => cleanup());

describe('ChartFrame', () => {
  it('re-subscribes its ResizeObserver when the measured node changes after a loading state', () => {
    // A plain `useRef` only ever sees the element from whichever render first mounted it; a
    // loading -> ready transition remounts the measured div, and a `[]`-deps effect never
    // re-observes it (brief defect #2). This mock proves `setRef`'s state-backed ref does.
    const observed: Element[] = [];
    class FakeResizeObserver {
      observe(element: Element) {
        observed.push(element);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { rerender } = render(
      <ChartFrame ariaLabel="Demo" loading renderChart={() => <svg />} />,
    );
    expect(observed).toHaveLength(0);
    rerender(<ChartFrame ariaLabel="Demo" renderChart={() => <svg />} />);
    expect(observed).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe('LineChart', () => {
  it("domains on the data's real min/max instead of always including 0", () => {
    // Two epoch-ms points ten units apart but both far from zero: the old `Math.min(...xs, 0)`
    // domain squeezed both points into the last pixels of the plot (brief defect #3). With the
    // real domain, their x positions should span almost the full plot width.
    const start = 1_760_000_000_000;
    const { container } = render(
      <LineChart
        width={300}
        series={[
          {
            key: 's',
            label: 'Series',
            points: [
              { x: start, y: 1 },
              { x: start + 10, y: 2 },
            ],
          },
        ]}
      />,
    );
    const circles = [...container.querySelectorAll('circle')];
    expect(circles).toHaveLength(2);
    const cx = circles.map((c) => Number(c.getAttribute('cx')));
    expect(Math.abs(cx[1] - cx[0])).toBeGreaterThan(150);
  });

  it('renders a p50-p95 band as a filled area behind the line', () => {
    const { container } = render(
      <LineChart
        width={200}
        series={[
          {
            key: 's',
            label: 'Series',
            points: [
              { x: 0, y: 5 },
              { x: 1, y: 6 },
            ],
            band: [
              { x: 0, low: 3, high: 7 },
              { x: 1, low: 4, high: 8 },
            ],
          },
        ]}
      />,
    );
    expect(container.querySelectorAll('path[opacity="0.1"]')).toHaveLength(1);
  });
});

describe('BarChart', () => {
  it('never renders a negative bar width with many grouped series', () => {
    const { container } = render(
      <BarChart
        width={120}
        seriesKeys={['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']}
        data={[{ category: 'x', values: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 } }]}
      />,
    );
    const widths = [...container.querySelectorAll('rect')].map((r) =>
      Number(r.getAttribute('width')),
    );
    expect(widths.every((w) => w > 0)).toBe(true);
  });

  it('shows a legend once there is more than one series, never colour alone', () => {
    const { container, rerender } = render(
      <BarChart width={200} seriesKeys={['a']} data={[{ category: 'x', values: { a: 1 } }]} />,
    );
    expect(container.querySelector('.ds-chart-legend')).toBeNull();
    rerender(
      <BarChart
        width={200}
        seriesKeys={['a', 'b']}
        data={[{ category: 'x', values: { a: 1, b: 2 } }]}
      />,
    );
    expect(container.querySelector('.ds-chart-legend')).not.toBeNull();
  });
});

describe('Donut', () => {
  it('still draws a visible ring for a single 100%-share category', () => {
    // A true 360° sweep makes an SVG arc's start and end points coincide, so the browser draws
    // nothing (brief defect #6 — one currency, one tier, every call completed).
    const { container } = render(<Donut slices={[{ label: 'Completed', value: 52 }]} />);
    const path = container.querySelector('path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('d')?.length ?? 0).toBeGreaterThan(20);
  });
});

describe('Waterfall', () => {
  it('clamps a stage bar at the plot edge instead of running under the overflow label', () => {
    const { container } = render(
      <Waterfall
        width={300}
        p95CapMs={1000}
        rows={[
          {
            label: 'Turn 1',
            stages: [{ stage: 'llm', ms: 1800, color: 'red' }],
          },
        ]}
      />,
    );
    const rect = container.querySelector('rect[fill="red"]');
    const plotWidth = 300 - 88 - 56; // MARGIN.left + MARGIN.right
    expect(Number(rect?.getAttribute('width'))).toBeLessThanOrEqual(plotWidth + 0.01);
    expect(container.querySelector('.ds-waterfall-overflow')).not.toBeNull();
  });

  it('lists every stage plus "Unattributed" in a legend', () => {
    const { container } = render(
      <Waterfall
        width={300}
        p95CapMs={1000}
        rows={[{ label: 'Turn 1', stages: [{ stage: 'stt', ms: 100, color: 'blue' }] }]}
      />,
    );
    const legend = container.querySelector('.ds-chart-legend');
    expect(legend?.textContent).toContain('stt');
    expect(legend?.textContent).toContain('Unattributed');
  });
});

describe('ProgressMeter', () => {
  it('marks an overspend instead of silently clamping the fill to 100%', () => {
    const { container } = render(<ProgressMeter label="Budget" max={100} value={120} />);
    expect(container.querySelector('.ds-meter-limit')).not.toBeNull();
    const img = container.querySelector('[role="img"]');
    expect(img?.getAttribute('aria-label')).toContain('over limit');
  });
});
