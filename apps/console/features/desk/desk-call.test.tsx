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

describe('the call in progress', () => {
  async function inCall(extra: Partial<DeskAcceptResult> = {}, queueInfo = queue()) {
    api.accept.mockResolvedValue(accepted(extra));
    await setup({ me: me({ queues: [queueInfo] }) });
    fireEvent.click(await screen.findByRole('button', { name: /Accept call/ }));
    await screen.findByText('Connected');
  }

  it('renders interim captions in place and firms them up', async () => {
    await inCall();
    act(() => room.client!.simulateCaption({ role: 'caller', text: 'my card', final: false, at: Date.now() }));
    expect(await screen.findByText('my card')).toBeTruthy();
    act(() => room.client!.simulateCaption({ role: 'caller', text: 'my card was charged twice', final: true, at: Date.now() }));
    expect(await screen.findByText('my card was charged twice')).toBeTruthy();
    expect(screen.queryByText('my card')).toBeNull();
    expect(screen.getByText('Before the transfer')).toBeTruthy();
    expect(screen.getByText('I was charged twice')).toBeTruthy();
  });

  it('confirms before hanging up, then ends the call', async () => {
    api.command.mockResolvedValue({ seq: 1 });
    await inCall();
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.command).toHaveBeenCalledWith('t1', { kind: 'end_call' }));
    expect(await screen.findByText(/This call has ended/)).toBeTruthy();
    expect(room.client!.state).toBe('disconnected');
  });

  it('does not hang up when the confirmation is cancelled', async () => {
    await inCall();
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.command).not.toHaveBeenCalled();
  });

  it('disables send-back, with the reason, when the queue has no AI targets', async () => {
    await inCall();
    const button = screen.getByRole('button', { name: 'Send back to AI agent' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('This queue has no AI agent to send callers back to.')).toBeTruthy();
  });

  it('sends the caller back to a chosen AI target after confirming', async () => {
    api.command.mockResolvedValue({ seq: 2 });
    const targets = [{ key: 'billing-bot', label: 'Billing assistant' }];
    await inCall({}, queue({ returnTargets: targets }));
    fireEvent.change(screen.getByLabelText('Send back to'), { target: { value: 'billing-bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Billing assistant/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.command).toHaveBeenCalledWith('t1', { kind: 'return_to_agent', target: 'billing-bot' }),
    );
  });

  it('mutes from the keyboard shortcut but not while typing', async () => {
    await inCall();
    fireEvent.keyDown(window, { key: 'm' });
    await waitFor(() => expect(room.client!.muted).toBe(true));
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }));
    const typing = document.createElement('textarea');
    document.body.append(typing);
    fireEvent.keyDown(typing, { key: 'm' });
    expect(room.client!.muted).toBe(true);
    typing.remove();
  });

  it('ends the call here when the server released it', async () => {
    await inCall();
    act(() =>
      stream.options!.onEvent({
        type: 'ticket',
        ticket: ticket('t1', { status: 'released', version: 3, releaseCode: 'call_ended', assignedOperatorId: 'u1' }),
      }),
    );
    expect(await screen.findByText(/This call has ended \(call ended\)/)).toBeTruthy();
  });

  it('requires wrap-up before Done and before the next accept when the queue says so', async () => {
    api.command.mockResolvedValue({ seq: 1 });
    api.wrapUp.mockResolvedValue(undefined);
    await inCall({}, queue({ wrapUp: { required: true, dispositions: ['Resolved', 'Escalated'] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/This call has ended/);
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save wrap-up' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Complete wrap-up for your last call first.')).not.toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Disposition'), { target: { value: 'Resolved' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'refund issued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save wrap-up' }));
    await waitFor(() =>
      expect(api.wrapUp).toHaveBeenCalledWith('t1', { disposition: 'Resolved', note: 'refund issued' }),
    );
    await waitFor(() => expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Active call')).toBeNull());
  });

  it('offers a retry with a fresh token when the room drops', async () => {
    api.token.mockResolvedValue(accepted().room);
    room.client = (await vi.importActual<typeof import('@winsendotai/ovo-ui/room')>('@winsendotai/ovo-ui/room')).createFakeRoomClient();
    room.client.failNextConnect('Token expired');
    api.accept.mockResolvedValue(accepted());
    await setup();
    fireEvent.click(await screen.findByRole('button', { name: /Accept call/ }));
    expect(await screen.findByText('Token expired')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.token).toHaveBeenCalledWith('t1'));
    expect(await screen.findByText('Connected')).toBeTruthy();
  });
});
