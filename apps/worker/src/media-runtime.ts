import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import {
  WorkerGatewayClient,
  type WorkerGatewayClientConfig,
  type WorkerMediaSession,
} from '@winsendotai/ovo-plugin-media';

export interface ManagedVoiceSession {
  dispose(reason?: string, closeMedia?: boolean): Promise<unknown>;
}

export interface VoiceSessionFactory {
  create(input: {
    job: DurableJob;
    route: SessionRoute;
    media: WorkerMediaSession;
  }): Promise<ManagedVoiceSession>;
}

export class WorkerMediaRuntime {
  private readonly client: WorkerGatewayClient;
  private readonly engines = new Map<string, ManagedVoiceSession>();

  constructor(
    config: WorkerGatewayClientConfig,
    private readonly store: DurableJobStore,
    private readonly factory: VoiceSessionFactory,
    private readonly onSessionClose?: (route: SessionRoute, reason: string) => void | Promise<void>,
    private readonly beforeSessionOpen?: (
      job: DurableJob,
      route: SessionRoute,
    ) => void | Promise<void>,
  ) {
    this.client = new WorkerGatewayClient(config, (media) => this.open(media));
  }

  connect(signal?: AbortSignal): Promise<void> {
    return this.client.connect(signal);
  }

  start(signal?: AbortSignal): Promise<void> {
    return this.connect(signal);
  }

  /** C2 replaces the legacy gateway internals while retaining this termination seam. */
  terminate(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, 'carrier termination');
  }

  async close(reason = 'worker media runtime closed'): Promise<void> {
    const engines = [...this.engines.values()];
    this.engines.clear();
    await Promise.allSettled(engines.map((engine) => engine.dispose(reason)));
    await this.client.close(reason);
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    const engine = this.engines.get(sessionId);
    if (!engine) return;
    this.engines.delete(sessionId);
    await engine.dispose(reason);
  }

  private async open(media: WorkerMediaSession): Promise<void> {
    const route = await this.store.resolveSessionRoute({ carrierCallId: media.identity.callSid });
    if (!route) throw new Error('carrier call has no durable session route');
    if (
      route.sessionId !== media.identity.sessionId ||
      route.workerId !== media.identity.ownerId ||
      route.ownerEpoch !== media.identity.ownerEpoch ||
      route.generation !== media.identity.generation
    ) {
      throw new Error('gateway session does not match durable route identity');
    }
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
      await this.onSessionClose?.(route, 'session_open_failed');
      throw error;
    }
    this.engines.set(route.sessionId, engine);
    media.onClose((reason) => {
      if (this.engines.get(route.sessionId) !== engine) return;
      this.engines.delete(route.sessionId);
      void (async () => {
        try {
          await engine.dispose(`media closed: ${reason}`, false);
        } finally {
          await this.onSessionClose?.(route, reason);
        }
      })();
    });
  }
}
