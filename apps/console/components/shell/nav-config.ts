import type { NavIconName } from './nav-icons';

export type NavGroupName =
  'Overview' | 'Build' | 'Calls' | 'Outbound' | 'Inbound' | 'Insights' | 'Settings';

export type NavItem = {
  href: string;
  label: string;
  group: NavGroupName;
  icon: NavIconName;
  adminOnly?: true;
};

/**
 * Grouped IA from the design brief §1 "Layout shell": Overview / Build / Calls / Outbound /
 * Inbound / Insights / Settings, replacing the old flat Build/Operations/Settings split (brief
 * defect #d — 11 items under one "Operations" heading).
 */
export const navigation: readonly NavItem[] = [
  { href: '/', label: 'Home', group: 'Overview', icon: 'home' },

  { href: '/agents', label: 'Agents', group: 'Build', icon: 'agents' },
  { href: '/settings/tools', label: 'Tools', group: 'Build', icon: 'plug' },
  { href: '/settings/providers', label: 'Providers & secrets', group: 'Build', icon: 'key' },

  { href: '/calls', label: 'Calls', group: 'Calls', icon: 'phone' },
  { href: '/operations/callbacks', label: 'Callbacks', group: 'Calls', icon: 'callback' },
  { href: '/operations/handoffs', label: 'Handoffs', group: 'Calls', icon: 'handoff' },

  { href: '/campaigns', label: 'Campaigns', group: 'Outbound', icon: 'megaphone' },
  { href: '/operations/suppressions', label: 'Do-not-call', group: 'Outbound', icon: 'ban' },
  { href: '/operations/compliance', label: 'Compliance', group: 'Outbound', icon: 'shield' },

  { href: '/operations/inbound', label: 'Routes & overflow', group: 'Inbound', icon: 'inbound' },

  { href: '/performance', label: 'Performance', group: 'Insights', icon: 'activity' },
  { href: '/costs', label: 'Costs & budgets', group: 'Insights', icon: 'wallet' },
  { href: '/infrastructure', label: 'Infrastructure', group: 'Insights', icon: 'server' },
  { href: '/evaluations', label: 'Evaluations', group: 'Insights', icon: 'flask' },

  { href: '/account', label: 'Account', group: 'Settings', icon: 'user' },
  { href: '/team', label: 'Team', group: 'Settings', icon: 'users', adminOnly: true },
] as const;

export const NAV_GROUPS: readonly NavGroupName[] = [
  'Overview',
  'Build',
  'Calls',
  'Outbound',
  'Inbound',
  'Insights',
  'Settings',
];

/** The nav item whose route matches (or is a parent of) `pathname`, longest href first so
 * `/operations/compliance` does not lose to a shorter unrelated prefix. */
export function matchNavItem(pathname: string): NavItem | undefined {
  return [...navigation]
    .sort((a, b) => b.href.length - a.href.length)
    .find(
      (item) =>
        pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`)),
    );
}

/** Group label for a route, used to build the topbar's two-level breadcrumb. */
export function groupOf(pathname: string): NavGroupName | undefined {
  return matchNavItem(pathname)?.group;
}
