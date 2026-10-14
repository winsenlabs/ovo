import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { matchNavItem } from './nav-config';

vi.mock('next/navigation', () => ({
  usePathname: () => '/operations/compliance',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

const identity = {
  id: 'usr_1',
  email: 'priya@sunrise.example',
  label: 'Priya Menon',
  role: 'admin' as const,
  workspaceId: 'ws_sunrise',
  workspace: { id: 'ws_sunrise', name: 'Sunrise Finance' },
};

afterEach(() => cleanup());

describe('nav-config', () => {
  it('groups every route under exactly one of the seven brief groups', () => {
    const groups = new Set([
      'Overview',
      'Build',
      'Calls',
      'Outbound',
      'Inbound',
      'Insights',
      'Settings',
    ]);
    expect(matchNavItem('/operations/compliance')?.group).toBe('Outbound');
    expect(matchNavItem('/costs')?.group).toBe('Insights');
    expect(matchNavItem('/')?.group).toBe('Overview');
    expect(groups.has(matchNavItem('/team')!.group)).toBe(true);
  });

  it('does not let the root route swallow every other path', () => {
    expect(matchNavItem('/agents')?.href).toBe('/agents');
  });
});

describe('Sidebar', () => {
  it('renders every group heading and marks the active route (brief defect #d — flat IA)', () => {
    render(<Sidebar identity={identity} />);
    for (const group of [
      'Overview',
      'Build',
      'Calls',
      'Outbound',
      'Inbound',
      'Insights',
      'Settings',
    ])
      expect(screen.getByText(group, { selector: '.nav-group > p' })).toBeTruthy();
    const active = screen.getByRole('link', { name: 'Compliance' });
    expect(active.className).toContain('active');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('hides Team from a non-admin', () => {
    render(<Sidebar identity={{ ...identity, role: 'editor' }} />);
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
  });

  it('keeps every group heading and a vertical link list in the mobile drawer variant (brief defect #4)', () => {
    render(<Sidebar identity={identity} variant="mobile" />);
    const nav = screen.getByRole('navigation', { name: 'Calls' });
    expect(within(nav).getByRole('link', { name: /Callbacks/ })).toBeTruthy();
    expect(screen.getByText('Outbound')).toBeTruthy();
  });
});

describe('Topbar', () => {
  it('shows a group / page breadcrumb from the route, not just the bare nav label (brief defect #c)', () => {
    render(<Topbar identity={identity} />);
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Outbound')).toBeTruthy();
    expect(within(breadcrumb).getByText('Compliance')).toBeTruthy();
  });
});
