import type { Server } from 'node:http';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { GatewayToWorkerMessage, WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import type { EndReason } from '@winsendotai/ovo-contracts';
import { asEndReason } from '@winsendotai/ovo-plugin-kit';
import { attachWorkerMediaServer, WorkerMediaLink } from './worker-media-server.ts';
import {
  authenticatedMediaRoute,
  activelyOwnedMediaJob,
  recordSessionOpened,
  type RouteTokenStore,
} from './session-handshake.ts';

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
      onOpen: (open, socket, handoff) => this.accept(open, socket, handoff),
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

  private async accept(open: Open, socket: WebSocket, handoff: () => void): Promise<void> {
    const route = await authenticatedMediaRoute(this.store, this.config.workerId, open);
    const existing = this.links.get(route.sessionId);
    if (socket.readyState !== WebSocket.OPEN) {
      if (!existing) await this.onSessionClose?.(route, 'error:media-disconnected-before-accept');
      throw new Error('worker media socket closed during route authentication');
    }
    if (existing) {
      if (open.generation <= existing.identity.generation)
        throw new Error('media rebind generation must advance');
      existing.rebind(open, socket);
      handoff();
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
    try {
      handoff();
    } catch (error) {
      link.finish('error:media-handshake-closed');
      await this.finalizing.get(route.sessionId);
      throw error;
    }
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
    const job = await activelyOwnedMediaJob(this.store, route);
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
    if (media instanceof WorkerMediaLink) {
      if (!this.store.pool || media.isClosed)
        throw new Error('media session closed before opening');
      await recordSessionOpened(this.store.pool, route);
      if (media.isClosed) throw new Error('media session opening was not durably recorded');
      return;
    }
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
