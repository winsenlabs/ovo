import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOLD } from '../../lib/derive/queues';
import { renderHook } from '@testing-library/react';
import { useLeaveGuard, LEAVE_MESSAGE } from '../../lib/use-leave-guard';
import { HoldEditor } from './hold-editor';
import { HoldTimeline } from './hold-timeline';
import { HoursEditor } from './hours-editor';
import { IssueList, issueCountLabel } from './issue-list';
import { KeyInput } from './key-input';
import { RoutingUnavailable, RoutingUnavailablePage } from './routing-unavailable';

afterEach(cleanup);

describe('HoldEditor additions', () => {
  it('reorders steps with buttons and keeps the queue behaviour of removing', () => {
    const onChange = vi.fn();
    const value = {
      ...DEFAULT_HOLD,
      steps: [
        { kind: 'silence' as const, seconds: 2 },
        { kind: 'silence' as const, seconds: 9 },
      ],
    };
    render(<HoldEditor value={value} audio={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Hold step 1 down' }));
    expect(onChange.mock.lastCall![0].steps.map((s: { seconds: number }) => s.seconds)).toEqual([
      9, 2,
    ]);
    expect(
      (screen.getByRole('button', { name: 'Move Hold step 1 up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hold step 2' }));
    expect(onChange.mock.lastCall![0].steps).toHaveLength(1);
  });
  it('picks queue and target keys from the lists it is given, and offers capacity waiting only to routing', () => {
    const onChange = vi.fn();
    const value = {
      ...DEFAULT_HOLD,
      onTimeout: [
        { kind: 'human' as const, queueId: '' },
        { kind: 'target' as const, key: '' },
        { kind: 'end' as const, line: { en: 'bye' } },
      ],
    };
    const { rerender } = render(
      <HoldEditor
        idPrefix="point-hold"
        value={value}
        audio={[]}
        choices={{ queues: ['desk'], targets: ['billing'] }}
        waitForCapacity
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Queue key'), { target: { value: 'desk' } });
    expect(onChange.mock.lastCall![0].onTimeout[0]).toEqual({ kind: 'human', queueId: 'desk' });
    fireEvent.change(screen.getByLabelText('Target key'), { target: { value: 'billing' } });
    expect(onChange.mock.lastCall![0].onTimeout[1]).toEqual({ kind: 'target', key: 'billing' });
    fireEvent.click(screen.getByRole('switch', { name: 'Wait when every agent is busy' }));
    expect(onChange.mock.lastCall![0].waitForCapacity).toBe(true);
    expect(document.getElementById('point-hold-max')).toBeTruthy();
    rerender(<HoldEditor value={value} audio={[]} onChange={onChange} />);
    expect(screen.queryByRole('switch', { name: 'Wait when every agent is busy' })).toBeNull();
  });
});

describe('HoursEditor required', () => {
  it('has no always-open switch and distinguishes its controls', () => {
    const hours = { timezone: 'Asia/Kolkata', weekly: {}, closed: [] };
    render(<HoursEditor required idPrefix="rule-hours" value={hours} onChange={vi.fn()} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(document.getElementById('rule-hours-zone')).toBeTruthy();
  });
});

describe('HoldTimeline', () => {
  it('describes the timeline in text, a table and clip lengths', () => {
    render(
      <HoldTimeline
        policy={{ ...DEFAULT_HOLD, maxSeconds: 10, steps: [{ kind: 'clip', assetId: 'a' }] }}
        clipSeconds={() => 4}
      />,
    );
    expect(screen.getByRole('img', { name: /3 parts over 10 seconds/ })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });
});

describe('small pieces', () => {
  it('lists issues with a severity in words', () => {
    render(
      <IssueList
        issues={[
          { code: 'x', severity: 'error', path: [], message: 'Broken' },
          { code: 'y', severity: 'warning', path: [], message: 'Hmm' },
        ]}
      />,
    );
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText('Warning')).toBeTruthy();
    expect(issueCountLabel(2, 1)).toBe('2 errors, 1 warning');
    expect(issueCountLabel(0, 0)).toBe('');
    cleanup();
    const { container } = render(<IssueList issues={[]} />);
    expect(container.innerHTML).toBe('');
  });
  it('commits a key once, and puts the old one back when refused', () => {
    const onCommit = vi.fn().mockReturnValueOnce('Taken').mockReturnValue(undefined);
    render(<KeyInput id="k" label="Key" value="a" onCommit={onCommit} />);
    const input = screen.getByLabelText('Key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'b' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('b');
    expect(screen.getByText('Taken')).toBeTruthy();
    expect(input.value).toBe('a');
    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
  it('renders each unavailable state of a routing screen', () => {
    const retry = vi.fn();
    const { rerender } = render(<RoutingUnavailable state={{ kind: 'disabled' }} />);
    expect(screen.getByText('Routing is not enabled here')).toBeTruthy();
    rerender(
      <RoutingUnavailable
        state={{ kind: 'error', message: 'down' }}
        onRetry={retry}
        what="Pools"
      />,
    );
    expect(screen.getByText('Pools could not be loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
    rerender(<RoutingUnavailable state={{ kind: 'loading' }} />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    rerender(<RoutingUnavailablePage title="Routing" state={{ kind: 'disabled' }} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Routing' })).toBeTruthy();
  });
});

describe('useLeaveGuard', () => {
  it('asks before an in-app link leaves a dirty page, and only then', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { rerender } = renderHook(({ dirty }) => useLeaveGuard(dirty), {
      initialProps: { dirty: false },
    });
    const link = document.createElement('a');
    link.href = '/routing';
    document.body.append(link);
    const click = () => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click()).toBe(false);
    rerender({ dirty: true });
    expect(click()).toBe(true);
    expect(confirm).toHaveBeenCalledWith(LEAVE_MESSAGE);
    confirm.mockReturnValue(true);
    expect(click()).toBe(false);
    link.href = 'https://elsewhere.example/';
    confirm.mockClear();
    click();
    expect(confirm).not.toHaveBeenCalled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    link.remove();
    confirm.mockRestore();
  });
});
