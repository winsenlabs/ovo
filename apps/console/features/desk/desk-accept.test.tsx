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

vi.mock('../../lib/data/desk-api', async () => (await import('./desk-test-support')).deskApiModule());
vi.mock('../../lib/data/desk-stream', async (original) =>
  (await import('./desk-test-support')).deskStreamModule(await original()),
);
vi.mock('@winsendotai/ovo-ui/room', async (original) =>
  (await import('./desk-test-support')).roomModule(await original()),
);

beforeEach(resetDesk);
afterEach(() => cleanup());

describe('accepting a call', () => {
  it('accepts, joins the room and shows the handover', async () => {
    api.accept.mockResolvedValue(accepted());
    await setup();
    fireEvent.click(await screen.findByRole('button', { name: /Accept call/ }));
    await waitFor(() => expect(api.accept).toHaveBeenCalledWith('t1', 1, expect.any(String)));
    expect(await screen.findByText('Active call')).toBeTruthy();
    await waitFor(() => expect(room.client!.grants).toHaveLength(1));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: /\+91/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.getByText('Caller disputes a late fee.')).toBeTruthy();
    expect(screen.getByText('Written by the AI agent that transferred the call')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByText('Account id: A-77', { exact: false })).toBeTruthy();
  });

  it('waits on Connecting caller until the caller seat is in the room', async () => {
    room.client = (await vi.importActual<typeof import('@winsendotai/ovo-ui/room')>('@winsendotai/ovo-ui/room')).createFakeRoomClient({
      callerJoins: false,
    });
    api.accept.mockResolvedValue(accepted());
    await setup();
    fireEvent.click(await screen.findByRole('button', { name: /Accept call/ }));
    expect(await screen.findByText('Connecting caller…')).toBeTruthy();
    act(() => room.client!.simulateCallerPresent(true));
    expect(await screen.findByText('Connected')).toBeTruthy();
  });

  it('rolls back and says so when another operator got there first', async () => {
    api.accept.mockRejectedValue(new ApiError(409, 'conflict', 'taken'));
    await setup();
    fireEvent.click(await screen.findByRole('button', { name: /Accept call/ }));
    expect(await screen.findByText('Another operator took this call.')).toBeTruthy();
    expect(screen.queryByText('Active call')).toBeNull();
    await waitFor(() => expect(api.tickets).toHaveBeenCalledTimes(4));
  });

  it('keeps the call on the queue when the room is unavailable', async () => {
    api.accept.mockRejectedValue(new ApiError(503, 'room_unavailable', 'room down'));
    await setup();
    fireEvent.click(await screen.findByRole('button', { name: /Accept call/ }));
    expect(
      await screen.findAllByText('Calls cannot be answered in the browser right now.'),
    ).not.toHaveLength(0);
    expect(screen.queryByText('Active call')).toBeNull();
  });

  it('declines an offered call', async () => {
    api.decline.mockResolvedValue(undefined);
    await setup({ tickets: [ticket('t1', { status: 'offered', offeredToMe: true, offerExpiresAt: new Date(Date.now() + 14_000).toISOString() })] });
    fireEvent.click(await screen.findByRole('button', { name: /Decline call/ }));
    await waitFor(() => expect(api.decline).toHaveBeenCalledWith('t1', 1));
    expect(await screen.findByText('No callers waiting')).toBeTruthy();
  });

  it('shows the rejoin offer for a call still open after a reload', async () => {
    const mine = ticket('t1', { status: 'accepted', assignedOperatorId: 'u1' });
    api.token.mockResolvedValue(accepted().room);
    await setup({ tickets: [], mine: [mine] });
    fireEvent.click(await screen.findByRole('button', { name: 'Rejoin call' }));
    await waitFor(() => expect(api.token).toHaveBeenCalledWith('t1'));
    expect(await screen.findByText('Connected')).toBeTruthy();
  });
});

