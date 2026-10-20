import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import {
  accepted,
  actualRoom,
  api,
  me,
  queue,
  resetDesk,
  room,
  setup,
  stream,
  ticket,
} from './desk-test-support';
import { DeskView } from './desk-view';

vi.mock('../../lib/data/desk-api', async () =>
  (await import('./desk-test-support')).deskApiModule(),
);
vi.mock('../../lib/data/desk-stream', async (original) =>
  (await import('./desk-test-support')).deskStreamModule(await original()),
);
vi.mock('@winsendotai/ovo-ui/room', async (original) =>
  (await import('./desk-test-support')).roomModule(await original()),
);

beforeEach(resetDesk);
afterEach(() => cleanup());

describe('operator desk states', () => {
  it('says the desk is switched off, not that it failed', async () => {
    api.me.mockRejectedValue(new ApiError(404, 'human_queue_disabled', 'off'));
    render(<DeskView />);
    expect(await screen.findByText('The operator desk is not enabled here')).toBeTruthy();
  });

  it('asks for an operator profile when the account has none', async () => {
    api.me.mockRejectedValue(new ApiError(403, 'operator_profile_required', 'no profile'));
    render(<DeskView />);
    expect(await screen.findByText('Your account is not set up as an operator')).toBeTruthy();
  });

  it('keeps the header and offers Retry on a failure', async () => {
    api.me.mockRejectedValueOnce(new Error('boom'));
    render(<DeskView />);
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Operator desk' })).toBeTruthy();
    api.me.mockResolvedValue(me());
    api.tickets.mockResolvedValue([]);
    api.roomStatus.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No callers waiting')).toBeTruthy();
  });

  it('says calls cannot be answered, and blocks Available, when the room is unreachable', async () => {
    api.me.mockResolvedValue(me({ status: 'OFFLINE' }));
    api.tickets.mockResolvedValue([]);
    api.roomStatus.mockResolvedValue({
      enabled: true,
      webhookEnabled: false,
      managedAvailable: true,
      room: { configured: true, provider: 'fake', reachable: false },
    });
    render(<DeskView />);
    expect(
      await screen.findByText(/Calls cannot be answered in the browser right now\. The room/),
    ).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Available' }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});

describe('queue and KPIs', () => {
  it('lists waiting callers with a ticking wait and honest KPIs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      await setup();
      expect(await screen.findByText('Support desk', { selector: 'strong' })).toBeTruthy();
      expect(screen.getByText('••••4321')).toBeTruthy();
      expect(screen.getByText('0:05')).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.getByText('0:08')).toBeTruthy();
      expect(screen.getByText('Waiting now').closest('article')?.textContent).toContain('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges stream events, announces a new caller and drops a removed one', async () => {
    await setup({ tickets: [] });
    await screen.findByText('No callers waiting');
    act(() => stream.options!.onEvent({ type: 'ticket', ticket: ticket('t9') }));
    expect(await screen.findByText('••••4321')).toBeTruthy();
    expect(screen.getByRole('status', { hidden: true, name: '' }).textContent).toBeDefined();
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
        'Caller waiting in Support desk',
      ),
    );
    act(() => stream.options!.onEvent({ type: 'removed', id: 't9' }));
    expect(await screen.findByText('No callers waiting')).toBeTruthy();
  });

  it('shows unknown, not zero, when the stream is stale', async () => {
    await setup();
    await screen.findByText('••••4321');
    act(() => stream.options!.onStatus('stale'));
    const tile = screen.getByText('Waiting now').closest('article')!;
    expect(within(tile).getByText('—')).toBeTruthy();
    expect(screen.getByText('Reconnecting to the queue')).toBeTruthy();
  });

  it('reloads the queue when the server reports a gap', async () => {
    await setup();
    await screen.findByText('••••4321');
    api.tickets.mockClear();
    act(() => stream.options!.onEvent({ type: 'gap' }));
    await waitFor(() => expect(api.tickets).toHaveBeenCalledTimes(2));
  });
});

describe('presence', () => {
  it('tests the microphone before going Available', async () => {
    room.probe.mockResolvedValue({ level: () => 0.4, stop: vi.fn() });
    api.setPresence.mockResolvedValue({ status: 'AVAILABLE' });
    await setup({ me: me({ status: 'OFFLINE' }), tickets: [] });
    fireEvent.click(screen.getByRole('radio', { name: 'Available' }));
    const go = await screen.findByRole('button', { name: 'Go available' });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }));
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(api.setPresence).toHaveBeenCalledWith('AVAILABLE'));
  });

  it('explains a blocked microphone and does not go Available', async () => {
    const { MicrophoneError } = await vi.importActual<typeof import('@winsendotai/ovo-ui/room')>(
      '@winsendotai/ovo-ui/room',
    );
    room.probe.mockRejectedValue(new MicrophoneError('denied'));
    await setup({ me: me({ status: 'OFFLINE' }), tickets: [] });
    fireEvent.click(screen.getByRole('radio', { name: 'Available' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Test microphone' }));
    expect(await screen.findByText(/browser blocked the microphone/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Go available' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.setPresence).not.toHaveBeenCalled();
  });

  it('goes Away without a microphone test and rolls back when the server refuses', async () => {
    api.setPresence.mockRejectedValue(new Error('presence down'));
    await setup({ tickets: [] });
    fireEvent.click(screen.getByRole('radio', { name: 'Away' }));
    expect(await screen.findByText('presence down')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Available' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('sends a heartbeat every 10 seconds while Available', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await setup({ tickets: [] });
      api.heartbeat.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_100);
      });
      expect(api.heartbeat).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks Accept with the reason until the operator is Available', async () => {
    await setup({ me: me({ status: 'AWAY' }) });
    const button = (await screen.findByRole('button', {
      name: /Accept call/,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Set yourself Available to accept calls.')).toBeTruthy();
  });
});
