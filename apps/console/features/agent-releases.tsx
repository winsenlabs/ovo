'use client';
import { useEffect, useState } from 'react';
import { apiRequest, items, type Release } from '../lib/api';
import { PageHeader } from '../components/ui/layout';
import { EmptyState } from '../components/ui/feedback';
export function AgentReleasesFeature({ agentId }: { agentId: string }) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => { void apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`).then(({ data }) => setReleases(items(data))).catch(failure => setError(failure instanceof Error ? failure.message : 'Releases unavailable')); }, [agentId]);
  return <div className="ui-stack"><PageHeader title="Releases" description="Immutable published configurations and their selected plugin versions." />
    {error && <p role="alert">{error}</p>}
    {!releases.length ? <EmptyState title="No releases yet" /> : <ol>{releases.map(release => <li className="panel panel-body" key={release.id}><strong>{release.id}</strong><pre className="mono">{JSON.stringify(release.selections, null, 2)}</pre></li>)}</ol>}
  </div>;
}
