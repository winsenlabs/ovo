import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Timeline, type TimelineEvent } from './timeline';
import { Conversation } from './conversation';
import { CodeBlock } from './code-block';
import { AudioPlayer } from './audio-player';

afterEach(() => cleanup());

const EVENTS: readonly TimelineEvent[] = [
  { id: '1', type: 'call.started', atMs: 0, summary: 'Call started' },
  { id: '2', type: 'turn.completed', atMs: 1200, summary: 'Turn completed' },
  { id: '3', type: 'call.started', atMs: 65000, summary: 'Call started again' },
];

describe('Timeline', () => {
  it('actually groups events under a heading instead of only claiming to', () => {
    render(<Timeline events={EVENTS} groupBy="minute" />);
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThanOrEqual(2);
  });
  it('humanises a dotted event type instead of showing it raw', () => {
    render(<Timeline events={EVENTS} />);
    expect(screen.queryByText('call.started')).toBeNull();
    expect(screen.getAllByText('Call started').length).toBeGreaterThan(0);
  });
  it('resets paging back to the first page when the type filter changes', () => {
    // 5 events, alternating type, pageSize 2: exhaust every page first (`visible` ends up at 6,
    // past the unfiltered total), then switch to a 3-item filter. Without a reset, `visible`
    // stays at 6 and all 3 filtered events show with no "more" button — indistinguishable from a
    // correct reset by that alone. With the reset, `visible` drops back to 2 and a "1 more"
    // button reappears, which is what this asserts.
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i}`,
      type: i % 2 === 0 ? 'call.started' : 'turn.completed',
      atMs: i * 1000,
      summary: `Event ${i}`,
    }));
    render(<Timeline events={many} pageSize={2} />);
    fireEvent.click(screen.getByText('3 more'));
    fireEvent.click(screen.getByText('1 more'));
    expect(screen.queryByText(/more$/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter by type'), {
      target: { value: 'call.started' },
    });
    expect(screen.getByText('1 more')).toBeTruthy();
  });
});

describe('Conversation', () => {
  it('names the speaker in text, not only through position and colour', () => {
    render(
      <Conversation
        lines={[
          { id: 'a', speaker: 'agent', atMs: 0, text: 'Hello' },
          { id: 'b', speaker: 'caller', atMs: 1000, text: 'Hi' },
        ]}
      />,
    );
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('Caller')).toBeTruthy();
  });
});

describe('AudioPlayer', () => {
  it('handles a rejected play() promise instead of leaving it unhandled', async () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(new DOMException('blocked'));
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    render(<AudioPlayer src="data:audio/wav;base64,AA==" durationMs={1000} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(playSpy).toHaveBeenCalled();
    // Resolve the microtask queue so the `.catch` handler runs before the test ends.
    await Promise.resolve()
      .then()
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });
});

describe('CodeBlock', () => {
  it('shows the size in the collapsed label for an already-in-memory string', () => {
    render(<CodeBlock code={JSON.stringify({ a: 1 })} />);
    expect(screen.getByRole('button').textContent).toMatch(/· .+B/);
  });
  it('downloads under a given filename instead of the hard-coded evidence.json', () => {
    render(<CodeBlock code="{}" filename="turn-costs.json" />);
    fireEvent.click(screen.getByRole('button'));
    const link = screen.getByText('Download').closest('a');
    expect(link?.getAttribute('download')).toBe('turn-costs.json');
  });
});
