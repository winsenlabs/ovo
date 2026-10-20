import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { operator, queuesApi, resetQueues } from './queues-test-support';
import { OperatorsTab } from './operators-tab';

vi.mock('../../lib/data/queues-api', async () =>
  (await import('./queues-test-support')).queuesApiModule(),
);

beforeEach(resetQueues);
afterEach(() => cleanup());

describe('Operators tab', () => {
  it('lists operators with live presence and load', async () => {
    queuesApi.operators.mockResolvedValue([
      operator(),
      operator({
        userId: 'u2',
        displayName: 'Ravi',
        status: 'OFFLINE',
        active: 0,
        languages: [],
        teamIds: [],
      }),
    ]);
    render(<OperatorsTab />);
    const table = await screen.findByRole('region', { name: 'Operators' });
    const asha = within(table).getByText('Asha', { selector: 'strong' }).closest('tr')!;
    expect(within(asha).getByText('Available')).toBeTruthy();
    expect(within(asha).getByText('1 of 2')).toBeTruthy();
    const ravi = within(table).getByText('Ravi', { selector: 'strong' }).closest('tr')!;
    expect(within(ravi).getByText('Offline')).toBeTruthy();
    expect(within(ravi).getByText('All')).toBeTruthy();
  });

  it('saves the profile with the new enabled flag when the switch is flipped', async () => {
    queuesApi.saveOperator.mockResolvedValue(undefined);
    render(<OperatorsTab />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Asha can answer' }));
    await waitFor(() => expect(queuesApi.saveOperator).toHaveBeenCalled());
    const [userId, profile] = queuesApi.saveOperator.mock.calls[0]!;
    expect(userId).toBe('u1');
    expect(profile).toMatchObject({ enabled: false, capacity: 2, teamIds: ['support'] });
    expect(profile).not.toHaveProperty('status');
    expect(profile).not.toHaveProperty('active');
  });

  it('adds an operator from a team member who is not one yet', async () => {
    queuesApi.saveOperator.mockResolvedValue(undefined);
    render(<OperatorsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add operator' }));
    fireEvent.change(await screen.findByLabelText('Team member'), { target: { value: 'u2' } });
    expect((screen.getByLabelText(/Name shown/) as HTMLInputElement).value).toBe('Ravi');
    fireEvent.change(screen.getByLabelText('Calls at once'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator' }));
    await waitFor(() =>
      expect(queuesApi.saveOperator).toHaveBeenCalledWith(
        'u2',
        expect.objectContaining({ displayName: 'Ravi', capacity: 3, enabled: true }),
      ),
    );
  });

  it('shows the empty state and the failure with Retry', async () => {
    queuesApi.operators.mockResolvedValueOnce([]);
    render(<OperatorsTab />);
    expect(await screen.findByText('No operators yet')).toBeTruthy();
    cleanup();
    queuesApi.operators.mockRejectedValueOnce(new Error('directory down'));
    render(<OperatorsTab />);
    expect(await screen.findByText('directory down')).toBeTruthy();
  });

  it('keeps the drawer open and says why when a save fails', async () => {
    queuesApi.saveOperator.mockRejectedValue(new Error('User is disabled'));
    render(<OperatorsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Asha' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save operator' }));
    expect(await screen.findByText('User is disabled')).toBeTruthy();
  });
});
