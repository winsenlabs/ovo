'use client';
// The one header and tab strip every agent sub-route shares (brief §3 "Agent detail / studio":
// a two-level layout with a shared agent header above link-tabs). It loads just enough — name,
// mode, draft version, readiness — to render that header; each tab still loads its own body data
// independently, exactly as the plugins/test/releases tabs already did before this rebuild.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  apiRequest,
  emptyAgentConfig,
  ifMatch,
  normalizeDraft,
  type AgentDraft,
  type AgentReadiness,
} from '../../lib/api';
import { useSession } from '../shell/session-provider';
import { Breadcrumb } from '../ui/layout';
import { LinkTabs } from '../ui/tabs';
import { StatusBadgeV2 } from '../ui/status-badge';
import { Skeleton } from '../ui/feedback-v2';
import { humaniseEnum } from '../../lib/status';

const TABS = [
  { id: 'overview', label: 'Overview', suffix: '' },
  { id: 'configure', label: 'Configure', suffix: '/configure' },
  { id: 'plugins', label: 'Voice & plugins', suffix: '/plugins' },
  { id: 'test', label: 'Test', suffix: '/test' },
  { id: 'releases', label: 'Releases', suffix: '/releases' },
] as const;

function readinessPill(readiness: AgentReadiness | undefined, error: string | undefined) {
  if (error) return <StatusBadgeV2 tone="neutral" label="Readiness unknown" />;
  if (!readiness) return <StatusBadgeV2 tone="neutral" label="Checking readiness…" />;
  if (readiness.releaseReady) return <StatusBadgeV2 tone="ok" label="Ready to publish" />;
  const count = readiness.blockers.length;
  return <StatusBadgeV2 tone="warn" label={`${count} release blocker${count === 1 ? '' : 's'}`} />;
}

export function AgentShell({ id, children }: { id: string; children: React.ReactNode }) {
  const identity = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [agent, setAgent] = useState<AgentDraft>();
  const [readiness, setReadiness] = useState<AgentReadiness>();
  const [readinessError, setReadinessError] = useState<string>();
  const [error, setError] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await apiRequest<unknown>(`/agents/${encodeURIComponent(id)}`);
      setAgent(normalizeDraft(result.data, result.etag));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This agent is unavailable');
    }
    try {
      const result = await apiRequest<AgentReadiness>(
        `/agents/${encodeURIComponent(id)}/readiness`,
      );
      setReadiness(result.data);
      setReadinessError(undefined);
    } catch {
      setReadinessError('unavailable');
    }
  }, [id]);
  // Re-checked on every tab switch (not just on mount) so Configure's edits are reflected in the
  // header's draft badge and readiness pill once the operator navigates back here.
  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  async function publish() {
    setPublishing(true);
    setPublishError(undefined);
    try {
      await apiRequest(`/agents/${encodeURIComponent(id)}/releases`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      router.push(`/agents/${encodeURIComponent(id)}/releases`);
    } catch (failure) {
      setPublishError(failure instanceof Error ? failure.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }

  async function duplicate() {
    if (!agent) return;
    setMenuOpen(false);
    const created = await apiRequest<unknown>('/agents', {
      method: 'POST',
      body: JSON.stringify({ config: emptyAgentConfig() }),
    });
    const draft = normalizeDraft(created.data, created.etag);
    await apiRequest(`/agents/${encodeURIComponent(draft.id)}`, {
      method: 'PUT',
      headers: { 'if-match': ifMatch(draft.draftVersion) },
      body: JSON.stringify({
        config: { ...agent.config, name: `${agent.config.name} copy` },
      }),
    });
    router.push(`/agents/${encodeURIComponent(draft.id)}/configure`);
  }

  function exportJson() {
    setMenuOpen(false);
    if (!agent) return;
    const blob = new Blob([JSON.stringify(agent.config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${agent.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (error && !agent)
    return (
      <div className="ui-stack">
        <p role="alert">{error}</p>
        <button className="button" type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );

  return (
    <div className="ui-stack">
      <header className="ds-page-header">
        <Breadcrumb
          trail={[{ label: 'Agents', href: '/agents' }, { label: agent?.config.name ?? '…' }]}
        />
        <div className="page-heading">
          <div>
            <h1>{agent ? agent.config.name : <Skeleton shape="text" width="12em" />}</h1>
            {agent && (
              <p className="ui-cluster">
                <StatusBadgeV2 tone="neutral" size="sm" label={humaniseEnum(agent.config.mode)} />
                <StatusBadgeV2 tone="neutral" size="sm" label={`Draft v${agent.draftVersion}`} />
              </p>
            )}
          </div>
          {agent && (
            <div className="heading-actions">
              {readinessPill(readiness, readinessError)}
              <Link className="button" href={`/agents/${encodeURIComponent(id)}/test`}>
                Test
              </Link>
              <button
                className="button primary"
                type="button"
                disabled={
                  publishing || identity.role === 'viewer' || readiness?.releaseReady !== true
                }
                onClick={() => void publish()}
              >
                {publishing
                  ? 'Validating…'
                  : readiness?.releaseReady === false
                    ? `Resolve ${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? '' : 's'}`
                    : !readiness
                      ? 'Checking readiness…'
                      : 'Publish release'}
              </button>
              <details className="ds-overflow-menu" open={menuOpen}>
                <summary
                  onClick={(event) => {
                    event.preventDefault();
                    setMenuOpen((value) => !value);
                  }}
                  aria-label="More actions"
                >
                  ⋯
                </summary>
                <div className="ds-overflow-menu-list">
                  <button type="button" onClick={() => void duplicate()}>
                    Duplicate
                  </button>
                  <button type="button" onClick={exportJson}>
                    Export JSON
                  </button>
                </div>
              </details>
            </div>
          )}
        </div>
      </header>
      {publishError && <p role="alert">{publishError}</p>}
      <LinkTabs
        items={TABS.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: `/agents/${encodeURIComponent(id)}${tab.suffix}`,
          current:
            tab.suffix === ''
              ? pathname === `/agents/${id}`
              : pathname.startsWith(`/agents/${id}${tab.suffix}`),
        }))}
      />
      {children}
    </div>
  );
}
