import { createHash, randomBytes } from 'node:crypto';
import type { StreamGrant } from '@winsendotai/ovo-contracts';

export interface GrantRoute {
  sessionId: string;
  dialRequestId?: string;
  carrierId?: string;
  bindingId?: string;
  status: string;
  terminalAt?: Date | null;
  terminalReason?: string | null;
}

export interface StreamGrantStore {
  resolveSessionRoute(query: {
    sessionId?: string;
    carrierCallId?: string;
    dialRequestId?: string;
    carrierRequestId?: string;
  }): Promise<GrantRoute | undefined>;
  issueStreamGrant(input: {
    dialRequestId?: string;
    carrierRequestId?: string;
    carrierCallId?: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<GrantRoute | undefined>;
  reissueStream(input: {
    carrierCallId: string;
    tokenHash: string;
    expiresAt: Date;
    workerFreshSeconds: number;
  }): Promise<GrantRoute | undefined>;
}

export interface GrantQuery {
  carrierId: string;
  bindingId: string;
  dialRequestId?: string;
  carrierCallId?: string;
  carrierRequestId?: string;
}

export interface GrantUrls {
  mediaUrl(carrierId: string, bindingId: string): string;
  callbackUrl(
    carrierId: string,
    bindingId: string,
    purpose: 'resume' | 'status',
    requestId: string,
  ): string;
}

const terminal = (route: GrantRoute) =>
  route.status === 'terminating' || Boolean(route.terminalAt || route.terminalReason);

function token(now: () => number) {
  const raw = randomBytes(32).toString('base64url');
  return {
    raw,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    expiresAt: new Date(now() + 60_000),
  };
}

function grant(route: GrantRoute, query: GrantQuery, raw: string, urls: GrantUrls): StreamGrant {
  const requestId =
    route.dialRequestId ?? query.dialRequestId ?? query.carrierRequestId ?? query.carrierCallId;
  return {
    kind: 'stream',
    mediaUrl: urls.mediaUrl(query.carrierId, query.bindingId),
    routeParams: { sid: route.sessionId, rt: raw },
    ...(requestId
      ? {
          resumeUrl: urls.callbackUrl(query.carrierId, query.bindingId, 'resume', requestId),
          statusUrl: urls.callbackUrl(query.carrierId, query.bindingId, 'status', requestId),
        }
      : {}),
  };
}

/** Token issuance happens only after the store re-checks status and fences under its own lock. */
export async function streamForDial(
  store: StreamGrantStore,
  query: GrantQuery,
  urls: GrantUrls,
  now: () => number,
): Promise<StreamGrant | { kind: 'ended' } | { kind: 'unmatched' }> {
  if (!query.dialRequestId && !query.carrierRequestId && !query.carrierCallId)
    return { kind: 'unmatched' };
  const prior = await store.resolveSessionRoute(query);
  if (!prior) return { kind: 'unmatched' };
  if (terminal(prior)) return { kind: 'ended' };
  if (
    (prior.carrierId && prior.carrierId !== query.carrierId) ||
    (prior.bindingId && prior.bindingId !== query.bindingId)
  )
    return { kind: 'unmatched' };
  const minted = token(now);
  const route = await store.issueStreamGrant({
    ...(query.dialRequestId ? { dialRequestId: query.dialRequestId } : {}),
    ...(query.carrierRequestId ? { carrierRequestId: query.carrierRequestId } : {}),
    ...(query.carrierCallId ? { carrierCallId: query.carrierCallId } : {}),
    tokenHash: minted.tokenHash,
    expiresAt: minted.expiresAt,
  });
  if (!route) return { kind: 'ended' };
  return grant(route, query, minted.raw, urls);
}

export async function resumeStream(
  store: StreamGrantStore,
  query: GrantQuery & { carrierCallId: string },
  urls: GrantUrls,
  now: () => number,
  workerFreshSeconds: number,
): Promise<StreamGrant | { kind: 'ended' }> {
  const prior = await store.resolveSessionRoute({ carrierCallId: query.carrierCallId });
  if (
    !prior ||
    terminal(prior) ||
    (prior.carrierId && prior.carrierId !== query.carrierId) ||
    (prior.bindingId && prior.bindingId !== query.bindingId)
  )
    return { kind: 'ended' };
  const minted = token(now);
  const route = await store.reissueStream({
    carrierCallId: query.carrierCallId,
    tokenHash: minted.tokenHash,
    expiresAt: minted.expiresAt,
    workerFreshSeconds,
  });
  if (
    !route ||
    (route.carrierId && route.carrierId !== query.carrierId) ||
    (route.bindingId && route.bindingId !== query.bindingId)
  )
    return { kind: 'ended' };
  return grant(route, query, minted.raw, urls);
}
