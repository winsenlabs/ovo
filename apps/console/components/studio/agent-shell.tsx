'use client';
// The one header and tab strip every agent sub-route shares (brief §3 "Agent detail / studio":
// a two-level layout with a shared agent header above link-tabs). It loads just enough — name,
// mode, draft version, readiness — to render that header; each tab still loads its own body data
// independently, exactly as the plugins/test/releases tabs already did before this rebuild.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  apiRequest,
  ApiError,
  normalizeDraft,
  type AgentDraft,
  type AgentReadiness,
} from '../../lib/api';
import { useSession } from '../shell/session-provider';
import { Breadcrumb } from '../ui/layout';
import { LinkTabs } from '../ui/tabs';
import { StatusBadgeV2 } from '../ui/status-badge';
import { ErrorState, Skeleton } from '../ui/feedback-v2';
import { humaniseEnum } from '../../lib/status';
import { SaveStateProvider, useDraftSaveState } from './save-state-context';
import { AgentShellMenu } from './agent-shell-menu';

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

const DIRTY_STATES = new Set(['dirty', 'saving']);

export function AgentShell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <SaveStateProvider>
      <AgentShellBody id={id}>{children}</AgentShellBody>
    </SaveStateProvider>
  );
}

function AgentShellBody({ id, children }: { id: string; children: React.ReactNode }) {
  const identity = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const saveState = useDraftSaveState();
  const [agent, setAgent] = useState<AgentDraft>();
  const [readiness, setReadiness] = useState<AgentReadiness>();
  const [readinessError, setReadinessError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notFound, setNotFound] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const result = await apiRequest<unknown>(`/agents/${encodeURIComponent(id)}`);
      setAgent(normalizeDraft(result.data, result.etag));
      setError(undefined);
      setNotFound(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This agent is unavailable');
      setNotFound(failure instanceof ApiError && failure.status === 404);
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
  // ...and the moment an autosave actually lands — otherwise the pill only catches up on the next
  // tab switch, which can be most of the way through editing (brief §3: Publish's readiness must
  // reflect the draft that would actually be published).
  const previousSaveState = useRef(saveState);
  useEffect(() => {
    if (previousSaveState.current !== 'saved' && saveState === 'saved') void refresh();
    previousSaveState.current = saveState;
  }, [saveState, refresh]);

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

  if (error && !agent)
    return (
      <div className="ui-stack">
        <Breadcrumb trail={[{ label: 'Agents', href: '/agents' }]} />
        <ErrorState
          title={notFound ? 'Agent not found' : 'This agent is unavailable'}
          message={error}
          onRetry={notFound ? undefined : () => void refresh()}
        />
        {notFound && (
          <Link className="button" href="/agents">
            Back to agents
          </Link>
        )}
      </div>
    );

  const dirty = DIRTY_STATES.has(saveState);
  const publishDisabled =
    publishing || identity.role === 'viewer' || readiness?.releaseReady !== true || dirty;

  return (
    <div className="ui-stack">
      <header className="ds-page-header">
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
                disabled={publishDisabled}
                onClick={() => void publish()}
              >
                {publishing
                  ? 'Validating…'
                  : dirty
                    ? 'Unsaved changes'
                    : readiness?.releaseReady === false
                      ? `Resolve ${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? '' : 's'}`
                      : !readiness
                        ? 'Checking readiness…'
                        : 'Publish release'}
              </button>
              <AgentShellMenu agent={agent} viewer={identity.role === 'viewer'} />
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
