import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { Login } from './login';
import { passwordClasses } from './password-change';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

const identity = { id: 'user-1', label: 'Owner', workspaceId: 'org', role: 'admin' };

beforeEach(() => {
  request.mockReset();
});
afterEach(() => cleanup());

function signIn(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

it('makes a flagged password change before signing in with the new one', async () => {
  const sessions: unknown[] = [];
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (path === '/auth/session') {
      sessions.push(body);
      return body.password === 'Password1234'
        ? {
            data: {
              identity,
              passwordChangeRequired: true,
              passwordIssues: [
                { code: 'common', message: 'Avoid common passwords and repeated patterns.' },
              ],
            },
          }
        : { data: { identity } };
    }
    if (path === '/auth/password' && init?.method === 'PATCH') return { data: undefined };
    throw new Error(`Unexpected API request: ${path}`);
  });
  const onAuthenticated = vi.fn();
  render(<Login onAuthenticated={onAuthenticated} />);
  signIn('owner@example.test', 'Password1234');
  expect(await screen.findByText('Avoid common passwords and repeated patterns.')).toBeTruthy();
  expect(onAuthenticated).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: 'Quiet-Harbour-71' },
  });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: 'Quiet-Harbour-71' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Change password and sign in' }));
  await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(identity));
  const [, init] = request.mock.calls.find(([path]) => path === '/auth/password')!;
  expect(JSON.parse(String(init.body))).toEqual({
    currentPassword: 'Password1234',
    newPassword: 'Quiet-Harbour-71',
  });
  expect(sessions).toEqual([
    { email: 'owner@example.test', password: 'Password1234' },
    { email: 'owner@example.test', password: 'Quiet-Harbour-71' },
  ]);
});

it('refuses a mismatched or simple new password before calling the API', async () => {
  request.mockResolvedValueOnce({
    data: { identity, passwordChangeRequired: true, passwordIssues: [] },
  });
  render(<Login onAuthenticated={vi.fn()} />);
  signIn('owner@example.test', 'Password1234');
  const next = await screen.findByLabelText('New password');
  fireEvent.change(next, { target: { value: 'alllowercaseletters' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: 'alllowercaseletters' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Change password and sign in' }));
  expect(await screen.findByText(/Mix three of lowercase/)).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
  expect(passwordClasses('Quiet-Harbour-71')).toBe(4);
});

it('shows the lockout message from the API', async () => {
  request.mockRejectedValueOnce(
    new ApiError(
      429,
      'account_locked',
      'Too many failed sign-ins for this account; try again in 15 minutes',
    ),
  );
  render(<Login onAuthenticated={vi.fn()} />);
  signIn('owner@example.test', 'Wrong-Guess-0000');
  expect(await screen.findByText(/try again in 15 minutes/)).toBeTruthy();
});
