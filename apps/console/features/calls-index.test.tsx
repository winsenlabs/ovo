import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallsIndexFeature } from './calls-index';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/calls',
}));
vi.mock('../components/shell/session-provider', () => ({
  useSession: () => ({ role: 'viewer' }),
}));
vi.mock('../lib/data/use-cursor-list', () => ({
  useCursorList: () => ({
    status: 'ready',
    items: [
      {
        id: 'call-recorded',
        kind: 'live',
        status: 'completed',
        outcome: { disposition: 'promise_to_pay', finalNode: 'goodbye' },
      },
      { id: 'call-silent', kind: 'live', status: 'active', outcome: null },
    ],
    hasPrevious: false,
    hasNext: false,
  }),
}));
afterEach(() => cleanup());

describe('calls index (AGT-8)', () => {
  it('shows each call disposition and final node from the list response', () => {
    render(<CallsIndexFeature />);
    const recorded = screen.getByRole('link', { name: 'call-recorded' }).closest('tr')!;
    expect(within(recorded).getByText('promise_to_pay')).toBeTruthy();
    expect(within(recorded).getByText('goodbye')).toBeTruthy();
    const silent = screen.getByRole('link', { name: 'call-silent' }).closest('tr')!;
    expect(within(silent).getAllByText('—')).toHaveLength(2);
  });
});
