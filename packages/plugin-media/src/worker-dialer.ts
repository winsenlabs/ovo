import WebSocket from 'ws';
import type { CarrierIngress, CarrierMediaEvent } from '@winsendotai/ovo-contracts';
import type {
  DurableMediaRoute,
  GatewayToWorkerMessage,
  MediaRouteResolver,
  WorkerToGatewayMessage,
} from './ports.ts';
import { encodeGatewayMessage, parseWorkerMessage } from './protocol.ts';

export interface WorkerLink {
  readonly bufferedBytes: number;
  send(message: GatewayToWorkerMessage): void;
  close(reason?: string): void;
}

export interface WorkerLinkEvents {
  onMessage(
    message: Exclude<WorkerToGatewayMessage, { type: 'session.accept' | 'session.reject' }>,
  ): void;
  onClose(reason: string): void;
}

export interface WorkerDialerOptions {
  workerToken: string;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
}

/** Resolve and correlate the durable route before opening a worker socket. */
export async function resolveWorkerRoute(input: {
  resolver: MediaRouteResolver;
  ingress: CarrierIngress;
  bindingId: string;
  authenticatedParams: Record<string, string>;
  start: Extract<CarrierMediaEvent, { type: 'start' }>;
  isClosed(): boolean;
}): Promise<{ route: DurableMediaRoute; sessionId: string; token: string } | undefined> {
  for (const [key, value] of Object.entries(input.start.routeParams))
    if (input.authenticatedParams[key] !== undefined && input.authenticatedParams[key] !== value)
      throw new Error(`conflicting carrier route parameter ${key}`);
  const fields = { ...input.authenticatedParams, ...input.start.routeParams };
  const sessionId = fields.sid ?? fields.sessionId;
  const token = fields.rt ?? fields.routeToken;
  if (
    !sessionId ||
    !token ||
    (fields.sid && fields.sessionId && fields.sid !== fields.sessionId) ||
    (fields.rt && fields.routeToken && fields.rt !== fields.routeToken)
  )
    throw new Error('missing authenticated session route parameters');
  const active = (route: DurableMediaRoute) =>
    !route.terminalAt && !route.releasedAt && route.status !== 'terminating';
  const authenticated = await input.resolver.authenticateSessionRoute(sessionId, token);
  if (input.isClosed()) return undefined;
  if (!authenticated || !active(authenticated))
    throw new Error('no live authenticated durable session route');
  if (authenticated.sessionId !== sessionId)
    throw new Error('authenticated session route ID does not match');
  let route: DurableMediaRoute = authenticated;
  if (route.carrierId && route.carrierId !== input.ingress.carrierId)
    throw new Error('carrier does not match durable session route');
  if ((route.bindingId ?? 'env') !== input.bindingId)
    throw new Error('binding does not match durable session route');
  const primary = route.carrierCallId;
  const alias = route.carrierStreamCallId;
  if (input.start.carrierCallId !== primary && input.start.carrierCallId !== alias) {
    if (primary && input.ingress.capabilities.control.streamCallIdMatchesDial === true)
      throw new Error('carrier stream call ID does not match dial call ID');
    const result = await input.resolver.bindCarrierCallId({
      organizationId: route.organizationId,
      carrierId: input.ingress.carrierId,
      sessionId,
      carrierCallId: input.start.carrierCallId,
    });
    if (input.isClosed()) return undefined;
    if (!('route' in result))
      throw new Error('carrier call ID could not be bound to session route');
    route = result.route;
  }
  if (route.carrierCallId && input.start.carrierCallId !== route.carrierCallId) {
    if (input.ingress.capabilities.control.streamCallIdMatchesDial === true)
      throw new Error('carrier stream call ID does not match dial call ID');
    await input.resolver.recordCarrierCallIdMismatch({
      sessionId,
      organizationId: route.organizationId,
      carrierId: input.ingress.carrierId,
      dialCallId: route.carrierCallId,
      streamCallId: input.start.carrierCallId,
    });
  }
  if (input.isClosed()) return undefined;
  if (!active(route) || route.sessionId !== sessionId)
    throw new Error('durable session route became terminal');
  if (
    route.jobId !== authenticated.jobId ||
    route.organizationId !== authenticated.organizationId ||
    route.workerId !== authenticated.workerId ||
    route.ownerEpoch !== authenticated.ownerEpoch ||
    route.generation !== authenticated.generation ||
    route.carrierId !== authenticated.carrierId ||
    route.bindingId !== authenticated.bindingId
  )
    throw new Error('durable session route ownership changed');
  if (
    route.carrierCallId !== input.start.carrierCallId &&
    route.carrierStreamCallId !== input.start.carrierCallId
  )
    throw new Error('carrier call ID was not durably bound');
  return { route, sessionId, token };
}

/** One gateway→worker link per carrier session on the worker's existing health port. */
export class WorkerDialer {
  private readonly handshakeTimeoutMs: number;
  private readonly maxMessageBytes: number;

  constructor(private readonly options: WorkerDialerOptions) {
    if (!options.workerToken) throw new TypeError('workerToken is required');
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  }

  connect(
    route: DurableMediaRoute,
    open: Extract<GatewayToWorkerMessage, { type: 'session.open' }>,
    events: WorkerLinkEvents,
    signal?: AbortSignal,
  ): Promise<WorkerLink> {
    if (signal?.aborted) return Promise.reject(new Error('worker media dial cancelled'));
    const endpoint = new URL(route.workerEndpoint);
    if (
      (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') ||
      endpoint.pathname !== '/internal/media' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new TypeError('Worker endpoint must be an unadorned /internal/media WebSocket URL');
    return new Promise<WorkerLink>((resolve, reject) => {
      const peer = new WebSocket(endpoint.href, {
        headers: { authorization: `Bearer ${this.options.workerToken}` },
        maxPayload: this.maxMessageBytes,
        perMessageDeflate: false,
        handshakeTimeout: this.handshakeTimeoutMs,
      });
      let state: 'pending' | 'accepted' | 'closed' = 'pending';
      const timer = setTimeout(
        () => fail(new Error('worker media acceptance timed out')),
        this.handshakeTimeoutMs,
      );
      timer.unref?.();
      const settledClose = (reason: string) => {
        if (state === 'closed') return;
        const pending = state === 'pending';
        state = 'closed';
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (pending) reject(new Error(reason));
        else events.onClose(reason);
      };
      const fail = (error: Error) => {
        settledClose(error.message);
        peer.terminate();
      };
      const abort = () => fail(new Error('worker media dial cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      const link: WorkerLink = {
        get bufferedBytes() {
          return peer.bufferedAmount;
        },
        send(message) {
          if (state !== 'accepted' || peer.readyState !== WebSocket.OPEN)
            throw new Error('worker media link is closed');
          peer.send(encodeGatewayMessage(message));
        },
        close(reason = 'gateway closing') {
          if (state === 'closed') return;
          peer.close(1000, Buffer.from(reason).subarray(0, 120).toString());
        },
      };
      peer.on('open', () => peer.send(encodeGatewayMessage(open)));
      peer.on('message', (data, isBinary) => {
        try {
          if (isBinary) throw new Error('worker media message must be JSON text');
          const message = parseWorkerMessage(data.toString(), this.maxMessageBytes);
          if (state === 'pending') {
            if (message.type === 'session.reject') return fail(new Error(message.reason));
            if (message.type !== 'session.accept')
              return fail(new Error('worker sent media before session acceptance'));
            state = 'accepted';
            clearTimeout(timer);
            resolve(link);
            return;
          }
          if (state === 'closed') return;
          if (message.type === 'session.accept' || message.type === 'session.reject')
            throw new Error('duplicate worker session decision');
          events.onMessage(message);
        } catch (error) {
          fail(error instanceof Error ? error : new Error('worker media protocol failed'));
        }
      });
      peer.on('close', (code, reason) =>
        settledClose(`worker media link closed (${code}): ${reason.toString()}`),
      );
      peer.on('error', () => settledClose('worker media link failed'));
    });
  }
}
