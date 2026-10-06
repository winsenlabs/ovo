import type { Server } from 'node:http';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { GatewayToWorkerMessage, WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import type { EndReason, Logger } from '@winsendotai/ovo-contracts';
import { asEndReason, createLogger, errorFields, redactLogText } from '@winsendotai/ovo-plugin-kit';
import { pluginFailureOf } from '@winsendotai/ovo-runtime';
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

/**
 * Where a session open failed: the durable route check, the owned job, admission (cost or
 * inbound capacity), engine composition (STT, TTS, graph), or the durable opened record.
 */
export type SessionOpenStage = 'route' | 'job' | 'admission' | 'compose' | 'record';

/**
 * The provider behind a session-open failure: the plugin whose start threw (recorded by the
 * runtime), else the first error in the cause chain that names its `provider` (and `kind`).
 */
export function sessionOpenSource(error: unknown): {
  provider?: string;
  providerKind?: string;
  pluginId?: string;
} {
  const started = pluginFailureOf(error);
  if (started)
    return {
      pluginId: started.pluginId,
      ...(started.provider ? { provider: started.provider } : {}),
      ...(started.kind ? { providerKind: started.kind } : {}),
    };
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const { provider, kind, cause } = current as {
      provider?: unknown;
      kind?: unknown;
      cause?: unknown;
    };
    if (typeof provider === 'string' && provider)
      return { provider, ...(typeof kind === 'string' && kind ? { providerKind: kind } : {}) };
    current = cause;
  }
  return {};
}

/**
 * `error:session-open-failed:<stage>:[<kind>/]<provider>: <message>` when the provider is known,
 * else `error:session-open-failed:<stage>:<message>`; scrubbed of credentials and kept short.
 */
export function sessionOpenFailure(stage: SessionOpenStage, error: unknown): EndReason {
  const message = redactLogText(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const { provider, providerKind } = sessionOpenSource(error);
  const source = provider ? `${providerKind ? `${providerKind}/` : ''}${provider}: ` : '';
  return `error:session-open-failed:${stage}:${source}${message}`;
}

const routeIds = (route: SessionRoute) => ({
  sessionId: route.sessionId,
  jobId: route.jobId,
  carrierCallId: route.carrierCallId,
  generation: route.generation,
});

export class WorkerMediaRuntime {
  private readonly engines = new Map<string, ManagedVoiceSession>();
  private readonly links = new Map<string, WorkerMediaLink>();
  private readonly finalizing = new Map<string, Promise<void>>();
  private detachServer?: () => Promise<void>;
  private readonly log: Logger;

  constructor(
    private readonly config: {
      workerId: string;
      token?: string;
      httpServer?: Server;
      url?: string;
      logger?: Logger;
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
  ) {
    this.log = (config.logger ?? createLogger({ service: 'worker' })).child({
      workerId: config.workerId,
    });
  }

  async start(): Promise<void> {
    if (this.detachServer) return;
    if (!this.config.httpServer || !this.config.token)
      throw new Error('worker media server requires its health server and bearer token');
    this.detachServer = attachWorkerMediaServer({
      httpServer: this.config.httpServer,
      token: this.config.token,
      logger: this.log,
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
        this.log.error('session_finalize_failed', {
          ...routeIds(route),
          reason,
          ...errorFields(error),
        });
      });
    });
    try {
      handoff();
    } catch (error) {
      this.log.warn('session_handoff_failed', { ...routeIds(route), ...errorFields(error) });
      link.finish('error:media-handshake-closed');
      await this.finalizing.get(route.sessionId);
      throw error;
    }
    // Acceptance is written before the factory awaits STT, TTS or graph composition.
    socket.send(JSON.stringify({ type: 'session.accept' }));
    const progress: { stage: SessionOpenStage } = { stage: 'route' };
    try {
      await this.open(link, route, progress);
      if (!link.isClosed) link.activate();
    } catch (error) {
      // accept was already sent, so the gateway never sees a session.reject: this line and the
      // terminal reason are the only record of why the call went silent. A caller who hung up
      // mid-open already closed the link; that is logged at warn and keeps its own reason.
      this.log[link.isClosed ? 'warn' : 'error']('session_open_failed', {
        ...routeIds(route),
        stage: progress.stage,
        ...sessionOpenSource(error),
        mediaClosedReason: link.closedReason,
        ...errorFields(error),
      });
      link.finish(sessionOpenFailure(progress.stage, error));
      await this.finalizing.get(route.sessionId);
      throw error;
    }
  }

  /** The route is selected by a scoped durable authentication before factory work begins. */
  private async open(
    media: WorkerMediaLink,
    route: SessionRoute,
    progress: { stage: SessionOpenStage } = { stage: 'route' },
  ): Promise<void> {
    if (!(media instanceof WorkerMediaLink))
      throw new Error('worker media requires an authenticated socket link');
    if (
      route.sessionId !== media.identity.sessionId ||
      route.workerId !== this.config.workerId ||
      route.ownerEpoch !== media.identity.ownerEpoch ||
      route.generation !== media.identity.generation
    )
      throw new Error('gateway session does not match durable route identity');
    if (route.terminalAt || route.releasedAt) throw new Error('durable session route is terminal');
    progress.stage = 'job';
    const job = await activelyOwnedMediaJob(this.store, route);
    progress.stage = 'admission';
    await this.beforeSessionOpen?.(job, route);
    progress.stage = 'compose';
    const engine = await this.factory.create({ job, route, media });
    if (media.isClosed) {
      await engine.dispose(asEndReason(media.closedReason ?? 'ownership_lost'), false);
      return;
    }
    this.engines.set(route.sessionId, engine);
    progress.stage = 'record';
    if (!this.store.pool || media.isClosed) throw new Error('media session closed before opening');
    await recordSessionOpened(this.store.pool, route);
    if (media.isClosed) throw new Error('media session opening was not durably recorded');
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
      // swallow-ok: every caller awaits `work` itself; the onClose path logs its failure.
      .catch(() => undefined);
    return work;
  }
}
