import { HomeDashboard } from './home-dashboard';

/**
 * `/` used to be a bare `redirect('/agents')` outside any route group, so it never passed through
 * the session gate on its own (brief §3 Home, §4 defect "Home (`/`) is a static redirect"). Moving
 * it here puts it under `(console)/layout.tsx`'s `serverSession` gate like every other screen, and
 * makes it a real overview dashboard instead of a detour to Agents.
 */
export default function Page() {
  return <HomeDashboard />;
}
