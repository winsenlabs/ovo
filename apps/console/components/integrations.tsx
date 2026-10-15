'use client';
import type { SessionIdentity } from '../lib/api';
import { ProvidersSettings } from './integrations/providers-settings';
import { ToolsSettings } from './integrations/tools-settings';

/**
 * Entry point for both `/settings/providers` and `/settings/tools` (kept at this path and with
 * this signature — `features/views.tsx` renders it directly). The two tabs used to share one
 * loader that fetched all four integration collections regardless of which page was open; they
 * now load only what their own screen needs.
 */
export function Integrations({
  initialTab,
  identity,
}: {
  initialTab: string;
  identity: SessionIdentity;
}) {
  return initialTab === 'tools' ? (
    <ToolsSettings identity={identity} />
  ) : (
    <ProvidersSettings identity={identity} />
  );
}
