'use client';
import { useEffect, useState } from 'react';
import type { RouteAgentRef } from '@winsendotai/ovo-contracts';
import { routingApi } from '../../lib/data/routing-api';
import { AgentSelect, useAgents } from './agent-select';
import { SelectField } from './fields';

/** An agent and which of its releases: the newest at publish (`latest`) or one release forever. */
export function AgentRefEditor({
  value,
  onChange,
  id,
  label = 'Agent',
  agents,
  error,
}: {
  value: RouteAgentRef;
  onChange: (value: RouteAgentRef) => void;
  id: string;
  label?: string;
  agents?: ReturnType<typeof useAgents>;
  error?: string;
}) {
  const own = useAgents();
  const list = agents ?? own;
  const pinned = value.release.kind === 'pinned';
  const [releases, setReleases] = useState<{ id: string; version?: number }[]>([]);
  useEffect(() => {
    if (!pinned || !value.agentId) return;
    let live = true;
    void routingApi.agentReleases(value.agentId).then(
      (rows) => live && setReleases(rows),
      () => live && setReleases([]),
    );
    return () => {
      live = false;
    };
  }, [pinned, value.agentId]);
  const releaseId = value.release.kind === 'pinned' ? value.release.releaseId : '';
  return (
    <div className="rt-stack">
      <AgentSelect
        id={`${id}-agent`}
        label={label}
        agents={list}
        value={value.agentId}
        error={error}
        onChange={(agentId) => onChange({ agentId, release: { kind: 'latest' } })}
      />
      <SelectField
        id={`${id}-release`}
        label={`${label} release`}
        value={pinned ? 'pinned' : 'latest'}
        options={[
          { value: 'latest', label: 'Newest release at publish' },
          { value: 'pinned', label: 'A specific release' },
        ]}
        help="Publishing pins the newest release either way; a specific one stays until you change it."
        onChange={(mode) =>
          onChange({
            ...value,
            release:
              mode === 'latest'
                ? { kind: 'latest' }
                : { kind: 'pinned', releaseId: releases[0]?.id ?? '' },
          })
        }
      />
      {pinned && (
        <SelectField
          id={`${id}-pinned`}
          label="Release"
          value={releaseId}
          placeholder="Choose a release…"
          options={(releaseId && !releases.some((r) => r.id === releaseId)
            ? [{ id: releaseId }, ...releases]
            : releases
          ).map((r) => ({
            value: r.id,
            label: `${'version' in r && r.version ? `v${r.version} · ` : ''}${r.id.slice(0, 8)}`,
          }))}
          onChange={(next) => onChange({ ...value, release: { kind: 'pinned', releaseId: next } })}
        />
      )}
    </div>
  );
}
