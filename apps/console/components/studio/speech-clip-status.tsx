'use client';
import { useEffect, useId, useState } from 'react';
import { apiRequest, items } from '../../lib/api';
import type { CampaignRecord, InboundRouteRecord } from '../../lib/operator-api';
import { Panel, PanelHeader, StatusBadge } from '../primitives';

/** `GET /v1/agents/:agentId/releases/:releaseId/speech-clips`. */
export interface SpeechClipStatus {
  state:
    | 'disabled'
    | 'unavailable'
    | 'not-requested'
    | 'queued'
    | 'running'
    | 'done'
    | 'failed'
    | 'skipped';
  total: number;
  ready: number;
  failed: number;
  pending: number;
  perCall: number;
  inventorySha256: string | null;
  detail: string | null;
  requestedAt: string | null;
  finishedAt: string | null;
}

type Load = (agentId: string, releaseId: string) => Promise<SpeechClipStatus>;

const loadStatus: Load = async (agentId, releaseId) =>
  (
    await apiRequest<SpeechClipStatus>(
      `/agents/${encodeURIComponent(agentId)}/releases/${encodeURIComponent(releaseId)}/speech-clips`,
    )
  ).data;

const LABELS: Record<SpeechClipStatus['state'], string> = {
  disabled: 'Cache off',
  unavailable: 'No clip store',
  'not-requested': 'Not pre-rendered',
  queued: 'Queued',
  running: 'Rendering',
  done: 'Ready',
  failed: 'Some lines failed',
  skipped: 'Skipped',
};

function tone(status: SpeechClipStatus): 'good' | 'warning' | 'danger' | 'soft' | 'neutral' {
  if (status.state === 'done' && !status.failed && !status.pending) return 'good';
  if (status.state === 'failed' || status.failed) return 'danger';
  if (status.state === 'disabled' || status.state === 'unavailable') return 'soft';
  return status.state === 'skipped' ? 'warning' : 'neutral';
}

/** Pre-rendered speech for one immutable release: how many fixed lines are ready to play. */
export function SpeechClipStatusPanel({
  agentId,
  releaseId,
  load = loadStatus,
  pollMs = 5_000,
  caption,
}: {
  agentId: string;
  releaseId: string;
  load?: Load;
  pollMs?: number;
  /** Which release this is and why it is shown, e.g. what routes to it. */
  caption?: string;
}) {
  const titleId = useId();
  const [status, setStatus] = useState<SpeechClipStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () =>
      load(agentId, releaseId).then(
        (next) => {
          if (!alive) return;
          setStatus(next);
          setError(undefined);
          if (next.state === 'queued' || next.state === 'running')
            timer = setTimeout(refresh, pollMs);
        },
        (cause: unknown) => {
          if (alive) setError(cause instanceof Error ? cause.message : 'Status is unavailable.');
        },
      );
    void refresh();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, releaseId, load, pollMs]);
  return (
    <Panel labelledBy={titleId}>
      <PanelHeader
        id={titleId}
        title="Pre-rendered speech"
        badge={
          status ? <StatusBadge tone={tone(status)}>{LABELS[status.state]}</StatusBadge> : null
        }
      >
        {caption && <small className="muted">{caption}</small>}
      </PanelHeader>
      <div className="panel-body stack">
        {error && <div className="notice danger">{error}</div>}
        {!status && !error && <div className="muted">Checking pre-rendered speech…</div>}
        {status && (
          <>
            <p>
              <strong>
                {status.ready} of {status.total}
              </strong>{' '}
              fixed lines ready to play without live synthesis
              {status.failed ? `, ${status.failed} failed` : ''}
              {status.pending && status.state !== 'disabled' ? `, ${status.pending} pending` : ''}.
            </p>
            {status.perCall > 0 && (
              <small className="muted">
                {status.perCall} templated line{status.perCall === 1 ? '' : 's'} with caller
                variables {status.perCall === 1 ? 'is' : 'are'} synthesized per call and never
                stored.
              </small>
            )}
            {status.detail && <small className="muted">{status.detail}</small>}
          </>
        )}
      </div>
    </Panel>
  );
}

/** Release id → what routes calls to it right now: enabled inbound numbers and live campaigns. */
export type RoutedReleases = Map<string, string[]>;

type LoadRouted = () => Promise<RoutedReleases>;

/** Each source is read on its own: an operator without one of them still sees the other. */
const loadRouted: LoadRouted = async () => {
  const routed: RoutedReleases = new Map();
  const add = (releaseId: string, via: string) =>
    routed.set(releaseId, [...(routed.get(releaseId) ?? []), via]);
  const [routes, campaigns] = await Promise.allSettled([
    apiRequest<unknown>('/operations/inbound/routes?limit=100'),
    apiRequest<unknown>('/operations/campaigns?limit=100'),
  ]);
  if (routes.status === 'fulfilled')
    for (const route of items<InboundRouteRecord>(routes.value.data))
      if (route.enabled) add(route.releaseId, route.phoneNumber);
  if (campaigns.status === 'fulfilled')
    for (const campaign of items<CampaignRecord>(campaigns.value.data))
      if (campaign.status === 'scheduled' || campaign.status === 'running')
        add(campaign.agentReleaseId, `campaign ${campaign.name}`);
  return routed;
};

/**
 * Clip readiness for the releases calls actually reach: every one of this agent's releases an
 * enabled inbound number or a live campaign points at, newest first. With nothing routed, the
 * newest release is shown, labelled as such. `releases` is oldest first, as the API lists them.
 */
export function RoutedSpeechClipStatus({
  agentId,
  releases,
  load,
  routedReleases = loadRouted,
}: {
  agentId: string;
  releases: readonly { id: string }[];
  load?: Load;
  routedReleases?: LoadRouted;
}) {
  const [routed, setRouted] = useState<RoutedReleases>();
  useEffect(() => {
    let alive = true;
    routedReleases().then(
      (found) => alive && setRouted(found),
      () => alive && setRouted(new Map()),
    );
    return () => {
      alive = false;
    };
  }, [routedReleases]);
  const newestFirst = [...releases].reverse();
  const shown = newestFirst.filter((release) => routed?.has(release.id));
  if (!routed || !newestFirst.length) return null;
  if (!shown.length)
    return (
      <SpeechClipStatusPanel
        agentId={agentId}
        releaseId={newestFirst[0]!.id}
        load={load}
        caption={`Newest release ${newestFirst[0]!.id}; no number or campaign routes to it yet.`}
      />
    );
  return (
    <>
      {shown.map((release) => (
        <SpeechClipStatusPanel
          key={release.id}
          agentId={agentId}
          releaseId={release.id}
          load={load}
          caption={`Release ${release.id}, routed from ${routed.get(release.id)!.join(', ')}.`}
        />
      ))}
    </>
  );
}
