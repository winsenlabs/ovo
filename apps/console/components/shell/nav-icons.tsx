import type { SVGProps } from 'react';

/**
 * One small inline-SVG icon per nav destination (16x16, single stroke weight). Kept local to the
 * shell: these are navigation glyphs, not vendor/provider icons, so they do not trip the
 * provider-icon-map lint gate (brief §2 "never hardcode vendor colour or icon maps" is about
 * `plugin.ui.vendor`, not the sidebar).
 */
export type NavIconName =
  | 'home'
  | 'agents'
  | 'plug'
  | 'key'
  | 'phone'
  | 'callback'
  | 'handoff'
  | 'megaphone'
  | 'ban'
  | 'shield'
  | 'inbound'
  | 'activity'
  | 'wallet'
  | 'server'
  | 'flask'
  | 'user'
  | 'users';

const PATHS: Record<NavIconName, string> = {
  home: 'M2 8.5 8 3l6 5.5M4 7v6.5h8V7M6.5 13.5V10h3v3.5',
  agents: 'M8 2.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM3.5 13c.5-3 2-4.5 4.5-4.5s4 1.5 4.5 4.5',
  plug: 'M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0V5ZM8 10.5V14',
  key: 'M6 9.5a2.5 2.5 0 1 1 2.45-3H14v2h-1.5V10H11V8.5H8.45A2.5 2.5 0 0 1 6 9.5Z',
  phone:
    'M3.2 3h2.3l.8 2.6-1.4 1.2a8 8 0 0 0 3.7 3.7l1.2-1.4 2.6.8v2.3c0 .6-.5 1-1 .9A10.6 10.6 0 0 1 3 4.3c0-.5.3-1 .2-1.3Z',
  callback:
    'M3.2 3h2.3l.8 2.6-1.4 1.2a8 8 0 0 0 3.7 3.7l1.2-1.4 2.6.8v2.3c0 .6-.5 1-1 .9A10.6 10.6 0 0 1 3 4.3c0-.5.3-1 .2-1.3ZM11 2.3l2 2-2 2M13 4.3H9.5',
  handoff: 'M2.5 5.5h7L7.5 3.5M13.5 10.5h-7l2 2M13.5 10.5l-2-2',
  megaphone:
    'M2.5 7v2l2.3.7L9 12V4L4.8 6.3 2.5 7Zm8-1.6a3 3 0 0 1 0 5.2M4.8 9.7 5.5 13h1.8l-.6-2.8',
  ban: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM4.3 4.3l7.4 7.4',
  shield: 'M8 2.3 13 4v4.3c0 3.3-2.2 5.4-5 6.4-2.8-1-5-3.1-5-6.4V4L8 2.3ZM5.8 8l1.6 1.6 2.8-3',
  inbound: 'M3.5 3h4L13 8.5l-5.5 5.5h-4L9 8.5 3.5 3Z',
  activity: 'M2 9h2.5l1.5-4 3 7 1.5-4H14',
  wallet:
    'M2.5 5.5a2 2 0 0 1 2-2h7a1 1 0 0 1 1 1v1h-9Zm0 0V11a2 2 0 0 0 2 2h7.5a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-9ZM11 9.75h.01',
  server: 'M3 3h10v3.2H3Zm0 6.6h10V13H3ZM5 4.6h.01M5 11.2h.01',
  flask:
    'M6.3 2.5h3.4M7 2.5v4.2l-3.6 5.6a1.4 1.4 0 0 0 1.2 2.2h6.8a1.4 1.4 0 0 0 1.2-2.2L9 6.7V2.5M5.6 10.3h4.8',
  user: 'M8 8.3a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM3 14c.5-3.3 2.3-5 5-5s4.5 1.7 5 5',
  users:
    'M5.6 7.8A2.1 2.1 0 1 0 5.6 3.6a2.1 2.1 0 0 0 0 4.2ZM1.8 13.2c.4-2.6 1.8-4 3.8-4s3.4 1.4 3.8 4M10.7 4.1a2 2 0 0 1 0 3.9M11.3 9.3c1.7.3 2.8 1.5 3 3.9h-2.4',
};

export function NavIcon({ name, ...props }: { name: NavIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
