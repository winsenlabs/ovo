'use client';
import { useEffect, useId, useState } from 'react';
import { apiRequest, items } from '../../lib/api';
import type { CampaignRecord, InboundRouteRecord } from '../../lib/operator-api';
import { formatPhoneNumber } from '../../lib/format';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { InlineAlert } from '../ui/feedback-v2';

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

function tone(status: SpeechClipStatus): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status.state === 'done' && !status.failed && !status.pending) return 'ok';
  if (status.state === 'failed' || status.failed) return 'danger';
  if (status.state === 'disabled' || status.state === 'unavailable') return 'neutral';
  return status.state === 'skipped' ? 'warn' : 'neutral';
}

/** `LABELS` is keyed only by `state`, and the API can report `state: 'done'` with some lines
 * still `failed` (a batch that finished with partial failures). `tone()` already reads `danger`
 * for that case; the label must agree, or the badge reads a red "Ready" (brief/verifier: tone
 * and text must never contradict each other). */
function label(status: SpeechClipStatus): string {
  if (status.state === 'done' && status.failed > 0) return LABELS.failed;
  if (status.state === 'done' && status.pending > 0) return 'Partially ready';
  return LABELS[status.state];
}

/** A routed-via entry is either a phone number or `campaign <name>`; only the former benefits
 * from grouped formatting (brief: phone numbers must never render as an unbroken digit string). */
function formatVia(via: string): string {
  return /^\+\d/.test(via) ? formatPhoneNumber(via) : via;
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
    <SectionCard
      id={titleId}
      title="Pre-rendered speech"
      description={caption}
      actions={status ? <StatusBadgeV2 tone={tone(status)} label={label(status)} /> : undefined}
    >
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {!status && !error && <p className="muted">Checking pre-rendered speech…</p>}
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
              {status.perCall} templated line{status.perCall === 1 ? '' : 's'} with caller variables{' '}
              {status.perCall === 1 ? 'is' : 'are'} synthesized per call and never stored.
            </small>
          )}
          {status.detail && <small className="muted">{status.detail}</small>}
        </>
      )}
    </SectionCard>
  );
}

/** Release id → what routes calls to it right now: enabled inbound numbers and live campaigns. */
export type RoutedReleases = Map<string, string[]>;

type LoadRouted = () => Promise<RoutedReleases>;

/** Each source is read on its own: an operator without one of them still sees the other. */
export const loadRouted: LoadRouted = async () => {
  const routed: RoutedReleases = new Map();
  const add = (releaseId: string, via: string) =>
    routed.set(releaseId, [...(routed.get(releaseId) ?? []), via]);
  const [routes, campaigns] = await Promise.allSettled([
    apiRequest<unknown>('/operations/inbound/routes?limit=100'),
    apiRequest<unknown>('/operations/campaigns?limit=100'),
  ]);
  if (routes.status === 'fulfilled')
    for (const route of items<InboundRouteRecord>(routes.value.data))
      // A routed number has no agent release of its own: its calls reach the router first.
      if (route.enabled && route.releaseId) add(route.releaseId, route.phoneNumber);
  if (campaigns.status === 'fulfilled')
    for (const campaign of items<CampaignRecord>(campaigns.value.data))
      if (campaign.status === 'scheduled' || campaign.status === 'running')
        add(campaign.agentReleaseId, `campaign ${campaign.name}`);
  return routed;
};

/**
 * Clip readiness for the releases calls actually reach: every one of this agent's releases an
 * enabled inbound number or a live campaign points at, newest first. With nothing routed, the
 * newest release is shown, labelled as such. `releases` must be given oldest first — the
 * opposite of what `/agents/:id/releases` itself returns (confirmed against the fixture: the
 * most recent `createdAt` comes back at index 0), so every caller here passes it reversed.
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
          caption={`Release ${release.id}, routed from ${routed
            .get(release.id)!
            .map(formatVia)
            .join(', ')}.`}
        />
      ))}
    </>
  );
}
