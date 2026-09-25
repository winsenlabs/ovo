import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { GatewayToWorkerMessage, WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import type { EndReason } from '@winsendotai/ovo-contracts';
import { asEndReason } from '@winsendotai/ovo-plugin-kit';
import { attachWorkerMediaServer, WorkerMediaLink } from './worker-media-server.ts';

export interface ManagedVoiceSession {
  dispose(reason?: EndReason, closeMedia?: boolean): Promise<unknown>;
}

export interface VoiceSessionFactory {
  create(input: {
    job: DurableJob;
    route: SessionRoute;
    media: WorkerMediaSession;
  }): Promise<ManagedVoiceSession>;
}

type Open = Extract<GatewayToWorkerMessage, { type: 'session.open' }>;

interface RouteTokenStore extends DurableJobStore {
  pool?: {
    query<T extends object>(sql: string, values: unknown[]): Promise<{ rows: T[] }>;
  };
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WorkerMediaRuntime {
  private readonly engines = new Map<string, ManagedVoiceSession>();
  private readonly links = new Map<string, WorkerMediaLink>();
  private readonly finalizing = new Map<string, Promise<void>>();
  private detachServer?: () => Promise<void>;

  constructor(
    private readonly config: {
      workerId: string;
      token?: string;
      httpServer?: Server;
      url?: string;
    },
    private readonly store: RouteTokenStore,
    private readonly factory: VoiceSessionFactory,
    private readonly onSessionClose?: (
      route: SessionRoute,
      reason: EndReason,
    ) => void | Promise<void>,
    private readonly beforeSessionOpen?: (
      job: DurableJob,
      route: SessionRoute,
    ) => void | Promise<void>,
  ) {}

  async connect(): Promise<void> {
    return this.start();
  }

  async start(): Promise<void> {
    if (this.detachServer) return;
    if (!this.config.httpServer || !this.config.token)
      throw new Error('worker media server requires its health server and bearer token');
    this.detachServer = attachWorkerMediaServer({
      httpServer: this.config.httpServer,
      token: this.config.token,
      onOpen: (open, socket) => this.accept(open, socket),
    });
  }

  async terminate(sessionId: string, reason: EndReason): Promise<void> {
    await this.closeSession(sessionId, reason);
  }

  async close(reason = 'worker media runtime closed'): Promise<void> {
    const detach = this.detachServer;
    this.detachServer = undefined;
    await detach?.();
    const ids = [...this.links.keys()];
    await Promise.allSettled(ids.map((sessionId) => this.closeSession(sessionId, reason)));
    await Promise.allSettled([...this.finalizing.values()]);
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    const link = this.links.get(sessionId);
    if (link) {
      try {
        await link.terminate(asEndReason(reason));
      } finally {
        await this.finalizing.get(sessionId);
      }
      return;
    }
    const engine = this.engines.get(sessionId);
    this.engines.delete(sessionId);
    await engine?.dispose(asEndReason(reason));
  }

  private async accept(open: Open, socket: WebSocket): Promise<void> {
    const route = await this.authenticatedRoute(open);
    const existing = this.links.get(route.sessionId);
    if (existing) {
      if (open.generation <= existing.identity.generation)
        throw new Error('media rebind generation must advance');
      existing.rebind(open, socket);
      socket.send(JSON.stringify({ type: 'session.accept' }));
      return;
    }
    const link = new WorkerMediaLink(open, socket);
    this.links.set(route.sessionId, link);
    // Register before factory.create: input overflow or a broken graph must finalize the route.
    link.onClose((reason) => {
      void this.finalizeSession(route, link, reason).catch((error: unknown) => {
        console.error('Worker media finalization failed', error);
      });
    });
    // Acceptance is written before the factory awaits STT, TTS or graph composition.
    socket.send(JSON.stringify({ type: 'session.accept' }));
    try {
      await this.open(link, route);
      if (!link.isClosed) link.activate();
    } catch (error) {
      link.finish('error:session-open-failed');
      await this.finalizing.get(route.sessionId);
      throw error;
    }
  }

  private async authenticatedRoute(open: Open): Promise<SessionRoute> {
    if (!this.store.pool) throw new Error('durable route token store is unavailable');
    const claim = await this.store.pool.query<{
      job_id: string;
      organization_id: string;
      carrier_id: string;
      handshake_token_hash: string;
      handshake_claimed_at: Date | null;
      worker_slot_epoch: string | null;
    }>(
      `SELECT job_id, organization_id, carrier_id, handshake_token_hash,
              handshake_claimed_at, worker_slot_epoch
       FROM ovo_session_routes WHERE session_id = $1`,
      [open.sessionId],
    );
    const row = claim.rows[0];
    const actualHash = createHash('sha256').update(open.routeToken, 'utf8').digest('hex');
    if (!row?.handshake_claimed_at || !sameHash(row.handshake_token_hash, actualHash))
      throw new Error('media route token was not claimed');
    const route = await this.store.resolveSessionRoute({
      organizationId: row.organization_id,
      carrierId: row.carrier_id,
      sessionId: open.sessionId,
      carrierCallId: open.carrierCallId,
    });
    if (
      !route ||
      route.sessionId !== open.sessionId ||
      route.jobId !== row.job_id ||
      route.workerId !== this.config.workerId ||
      route.ownerEpoch !== open.ownerEpoch ||
      route.generation !== open.generation ||
      route.carrierId !== open.carrierId ||
      row.carrier_id !== open.carrierId ||
      (route.bindingId ?? 'env') !== open.bindingId ||
      (route.carrierCallId !== open.carrierCallId &&
        route.carrierStreamCallId !== open.carrierCallId) ||
      route.terminalAt ||
      route.releasedAt ||
      route.status === 'terminating'
    )
      throw new Error('media route does not match the active owner');
    const slot = await this.store.pool.query<{ ownership_epoch: string }>(
      `SELECT ownership_epoch FROM ovo_worker_slots
       WHERE worker_id = $1 AND state IN ('reserved', 'active')
         AND lease_expires_at > now()`,
      [route.workerId],
    );
    if (!row.worker_slot_epoch || slot.rows[0]?.ownership_epoch !== row.worker_slot_epoch)
      throw new Error('worker slot lease no longer owns the media route');
    const job = await this.store.get(route.jobId);
    if (
      !job ||
      job.ownerId !== route.workerId ||
      job.ownerEpoch !== route.ownerEpoch ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt.getTime() <= Date.now() ||
      !['dialing', 'reconcile_required', 'accepted', 'connected'].includes(job.status)
    )
      throw new Error('durable job is not actively owned by the routed worker');
    return route;
  }

  /** The route is selected by a scoped durable authentication before factory work begins. */
  private async open(media: WorkerMediaSession, route: SessionRoute): Promise<void> {
    if (
      route.sessionId !== media.identity.sessionId ||
      route.workerId !== this.config.workerId ||
      route.ownerEpoch !== media.identity.ownerEpoch ||
      route.generation !== media.identity.generation
    )
      throw new Error('gateway session does not match durable route identity');
    if (route.terminalAt || route.releasedAt) throw new Error('durable session route is terminal');
    const job = await this.store.get(route.jobId);
    if (
      !job ||
      job.ownerId !== route.workerId ||
      job.ownerEpoch !== route.ownerEpoch ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt.getTime() <= Date.now() ||
      !['dialing', 'reconcile_required', 'accepted', 'connected'].includes(job.status)
    )
      throw new Error('durable job is not actively owned by the routed worker');
    await this.beforeSessionOpen?.(job, route);
    let engine: ManagedVoiceSession;
    try {
      engine = await this.factory.create({ job, route, media });
    } catch (error) {
      if (!(media instanceof WorkerMediaLink))
        await this.onSessionClose?.(route, 'error:session-open-failed');
      throw error;
    }
    if (media instanceof WorkerMediaLink && media.isClosed) {
      await engine.dispose(asEndReason(media.closedReason ?? 'ownership_lost'), false);
      return;
    }
    this.engines.set(route.sessionId, engine);
    if (media instanceof WorkerMediaLink) return;
    // Direct legacy fixture seam until the owned media-runtime tests migrate to the socket path.
    media.onClose((reason) => {
      if (this.engines.get(route.sessionId) !== engine) return;
      this.engines.delete(route.sessionId);
      this.links.delete(route.sessionId);
      void (async () => {
        try {
          await engine.dispose(asEndReason(reason), false);
        } finally {
          await this.onSessionClose?.(route, asEndReason(reason));
        }
      })();
    });
  }

  private finalizeSession(
    route: SessionRoute,
    link: WorkerMediaLink,
    reason: string,
  ): Promise<void> {
    const sessionId = route.sessionId;
    if (this.links.get(sessionId) !== link) return Promise.resolve();
    const prior = this.finalizing.get(sessionId);
    if (prior) return prior;
    const work = (async () => {
      this.links.delete(sessionId);
      const engine = this.engines.get(sessionId);
      this.engines.delete(sessionId);
      try {
        await engine?.dispose(asEndReason(reason), false);
      } finally {
        await this.onSessionClose?.(route, asEndReason(reason));
      }
    })();
    this.finalizing.set(sessionId, work);
    void work
      .finally(() => {
        if (this.finalizing.get(sessionId) === work) this.finalizing.delete(sessionId);
      })
      .catch(() => undefined);
    return work;
  }
}
