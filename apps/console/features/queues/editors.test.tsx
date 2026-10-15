import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HoldPolicy, Lines, QueueHours } from '../../lib/types/queues';
import { DEFAULT_HOLD } from '../../lib/derive/queues';
import { HoldEditor } from './hold-editor';
import { HoursEditor } from './hours-editor';
import { LinesEditor } from './lines-editor';

afterEach(() => cleanup());

describe('LinesEditor', () => {
  it('adds a language, edits its text and removes it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LinesEditor label="Announcement" value={{ en: 'Hello' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Announcement (en)'), { target: { value: 'Hi' } });
    expect(onChange).toHaveBeenLastCalledWith({ en: 'Hi' });
    fireEvent.change(screen.getByLabelText('Add a language to Announcement'), { target: { value: 'HI' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).toHaveBeenLastCalledWith({ en: 'Hello', hi: '' });
    rerender(<LinesEditor label="Announcement" value={{ en: 'Hello' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove en from Announcement' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('ignores an invalid or duplicate code', () => {
    const onChange = vi.fn();
    render(<LinesEditor label="Line" value={{ en: 'x' }} onChange={onChange} />);
    for (const code of ['e', 'english', 'en']) {
      fireEvent.change(screen.getByLabelText('Add a language to Line'), { target: { value: code } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never lets a required line lose its last language', () => {
    render(<LinesEditor label="Line" required value={{ en: 'x' }} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Remove en/ })).toBeNull();
  });
});

describe('HoursEditor', () => {
  const hours: QueueHours = {
    timezone: 'Asia/Kolkata',
    weekly: { mon: [{ start: '09:00', end: '18:00' }] },
    closed: [],
  };
  it('turns hours on with weekday defaults and back off', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HoursEditor value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Only open during set hours' }));
    const created = onChange.mock.calls[0]![0] as QueueHours;
    expect(Object.keys(created.weekly)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    rerender(<HoursEditor value={hours} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Only open during set hours' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('edits a day’s window, ticks a new day and unticks one', () => {
    const onChange = vi.fn();
    render(<HoursEditor value={hours} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Monday closes'), { target: { value: '20:00' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...hours, weekly: { mon: [{ start: '09:00', end: '20:00' }] } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tuesday' }));
    expect((onChange.mock.calls.at(-1)![0] as QueueHours).weekly.tue).toEqual([{ start: '09:00', end: '18:00' }]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monday' }));
    expect((onChange.mock.calls.at(-1)![0] as QueueHours).weekly.mon).toBeUndefined();
    expect((screen.getByLabelText('Tuesday opens') as HTMLInputElement).disabled).toBe(true);
  });

  it('keeps the other windows of a day it only edits the first of', () => {
    const onChange = vi.fn();
    const split: QueueHours = {
      ...hours,
      weekly: { mon: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
    };
    render(<HoursEditor value={split} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Monday opens'), { target: { value: '08:00' } });
    expect((onChange.mock.calls[0]![0] as QueueHours).weekly.mon).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '14:00', end: '18:00' },
    ]);
  });
});

describe('HoldEditor', () => {
  const clip = [{ value: 'clip-1', label: 'Hold music' }];
  it('starts a hold from the default and clears it again', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HoldEditor value={undefined} audio={clip} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Custom hold experience' }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_HOLD);
    rerender(<HoldEditor value={DEFAULT_HOLD} audio={clip} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Custom hold experience' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('changes a step’s kind, chooses a clip and removes a step', () => {
    const onChange = vi.fn();
    const hold: HoldPolicy = { ...DEFAULT_HOLD, steps: [{ kind: 'silence', seconds: 2 }] };
    render(<HoldEditor value={hold} audio={clip} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Hold step 1 type'), { target: { value: 'clip' } });
    expect((onChange.mock.calls.at(-1)![0] as HoldPolicy).steps).toEqual([{ kind: 'clip', assetId: '' }]);
    cleanup();
    render(<HoldEditor value={{ ...hold, steps: [{ kind: 'clip', assetId: '' }] }} audio={clip} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'clip-1' } });
    expect((onChange.mock.calls.at(-1)![0] as HoldPolicy).steps[0]).toEqual({ kind: 'clip', assetId: 'clip-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hold step 1' }));
    expect((onChange.mock.calls.at(-1)![0] as HoldPolicy).steps).toEqual([]);
  });

  it('says there are no clips rather than showing an empty picker', () => {
    const hold: HoldPolicy = { ...DEFAULT_HOLD, steps: [{ kind: 'clip', assetId: '' }] };
    render(<HoldEditor value={hold} audio={[]} onChange={vi.fn()} />);
    expect(screen.getByText('No clips uploaded')).toBeTruthy();
  });

  it('edits a timeout step per kind and caps both lists', () => {
    const onChange = vi.fn();
    const hold: HoldPolicy = {
      ...DEFAULT_HOLD,
      onTimeout: [{ kind: 'callback', inMinutes: 60, line: { en: 'Bye' } as Lines }],
    };
    render(<HoldEditor value={hold} audio={clip} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Call back in'), { target: { value: '90' } });
    expect((onChange.mock.calls.at(-1)![0] as HoldPolicy).onTimeout[0]).toMatchObject({ kind: 'callback', inMinutes: 90 });
    fireEvent.change(screen.getByLabelText('Timeout step 1 type'), { target: { value: 'human' } });
    expect((onChange.mock.calls.at(-1)![0] as HoldPolicy).onTimeout[0]).toEqual({ kind: 'human', queueId: '' });
    cleanup();
    const full = Array.from({ length: 5 }, () => ({ kind: 'default' as const }));
    render(<HoldEditor value={{ ...hold, onTimeout: full }} audio={clip} onChange={onChange} />);
    expect((screen.getByRole('button', { name: 'Add timeout step' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
