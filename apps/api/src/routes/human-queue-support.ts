import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { MediaRoomProvider, OperatorProfile } from '@winsendotai/ovo-contracts';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { OperationsService, HumanQueueService } from '@winsendotai/ovo-plugin-operations';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import type { CallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import type { HumanQueueEgress } from '../human-queue-ports.ts';
import type { Principal } from '../types.ts';
import type { UserDirectory } from '../user-directory.ts';
import { routingAudit, sendError, type RoutingAudit } from './routing-support.ts';

/** A released or expired managed ticket whose room still needs closing (the room reaper's work). */
export interface RoomToClose {
  id: string;
  roomName: string;
  operatorId?: string;
}

/**
 * The human queue service as the API uses it: the storage port plus the few reads the desk stream,
 * the room reaper and the status route need. Core's service provides `roomsToClose` and `head`
 * (so the intersection below is required once it does); `head` has a fallback in the desk stream,
 * `roomsToClose` has none: without it no room is ever reaped. `lastSweep` is optional for good.
 */
export type ApiHumanQueueService = HumanQueueService & {
  lastSweep?(): Promise<string | undefined>;
  tickets: HumanQueueService['tickets'] & {
    /** The newest change id: where a new desk stream starts. */
    head?(): Promise<number>;
    roomsToClose?(limit: number): Promise<RoomToClose[]>;
  };
};

/** `OperationsService.humanQueues` (operations 013), when this installation has PostgreSQL. */
export function humanQueuesOf(
  operations: OperationsService | undefined,
): ApiHumanQueueService | undefined {
  return (operations as (OperationsService & { humanQueues?: ApiHumanQueueService }) | undefined)
    ?.humanQueues;
}

export interface HumanQueueFlags {
  /** `OVO_HUMAN_QUEUE_ENABLED`. */
  enabled: boolean;
  /** `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`. */
  webhookEnabled: boolean;
}

/** Everything the `/v1/human-queues|desk|human-queue/*` routes need (design 6). */
export interface HumanQueueRouteDependencies {
  app: FastifyInstance;
  store: ControlStore;
  requireRole: (request: FastifyRequest, role: Role) => Principal;
  expectedVersion: (request: FastifyRequest) => number;
  operations?: OperationsService;
  flags: HumanQueueFlags;
  /** `Cap.mediaRoom`, absent unless the room plugin is composed. */
  rooms?: MediaRoomProvider;
  roomTokenTtlSeconds: number;
  presenceTtlSeconds: number;
  /** Origin put in the links of a synthetic test request (`/api/v1/human-queue/...`). */
  callbackBaseUrl: string;
  users?: Pick<UserDirectory, 'list'>;
  secrets?: Pick<SecretManager, 'resolve' | 'forAgent'>;
  outcomes?: { available: boolean; open(): Promise<CallOutcomeStore> };
  ledger?: Pick<CostLedgerService, 'getPriceCard'>;
  egress: HumanQueueEgress;
  now?: () => number;
  sse?: {
    maxConnections?: number;
    pollMs?: number;
    heartbeatMs?: number;
    maxBufferedBytes?: number;
  };
}

export interface HumanQueueCall {
  request: FastifyRequest;
  reply: FastifyReply;
  principal: Principal;
  queues: ApiHumanQueueService;
  audit: RoutingAudit;
}

export const humanQueueAudit = (store: ControlStore): RoutingAudit => routingAudit(store);

/** 404 `human_queue_disabled`: the flag is off, or there is no PostgreSQL operations service. */
export function disabled(reply: FastifyReply) {
  return sendError(reply, 404, 'human_queue_disabled', 'Human queues are not enabled');
}

/**
 * The human queue service for this principal, or the reply already sent. The dark switch is
 * checked first, so a disabled installation never says more than 404.
 */
export function queuesOr404(
  input: Pick<HumanQueueRouteDependencies, 'flags' | 'operations'>,
  reply: FastifyReply,
  principal: Principal,
): ApiHumanQueueService | undefined {
  const queues = input.flags.enabled ? humanQueuesOf(input.operations) : undefined;
  if (!queues) return void disabled(reply);
  if (input.operations!.organizationId !== principal.workspaceId)
    return void sendError(
      reply,
      403,
      'operations_scope_mismatch',
      'Operations service is not configured for this workspace',
    );
  return queues;
}

/** A `/v1/human-queues/*` handler behind its role check and the dark switch. */
export function queued(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit },
  role: Role,
  handler: (call: HumanQueueCall) => unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = input.requireRole(request, role);
    const queues = queuesOr404(input, reply, principal);
    if (!queues) return;
    return handler({ request, reply, principal, queues, audit: input.audit });
  };
}

export interface DeskCall extends HumanQueueCall {
  profile: OperatorProfile;
}

/**
 * A `/v1/desk/*` handler: a viewer who also has an enabled operator profile. The profile is what
 * lets an account answer calls, so an admin without one is refused like anyone else.
 */
export function desked(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit },
  handler: (call: DeskCall) => unknown,
) {
  return queued(input, 'viewer', async (call) => {
    const profile = await call.queues.operators.get(call.principal.identityId);
    if (!profile?.enabled)
      return sendError(
        call.reply,
        403,
        'operator_profile_required',
        'Your account is not set up as an operator',
      );
    return handler({ ...call, profile });
  });
}

/** One validation problem: where, what, and (for a routing code) which. */
export interface ApiIssue {
  path: (string | number)[];
  message: string;
  code?: string;
}

/** A zod error as API issues (symbol path steps cannot occur in our schemas, but are dropped). */
export function zodIssues(error: z.ZodError): ApiIssue[] {
  return error.issues.map((found) => ({
    path: found.path.filter((step): step is string | number => typeof step !== 'symbol'),
    message: found.message,
  }));
}

/** 422 with the issue list in the shape every routing validation uses. */
export function invalid(
  reply: FastifyReply,
  code: string,
  message: string,
  issues: readonly ApiIssue[],
) {
  return sendError(reply, 422, code, message, { issues });
}

/** A cached reachability probe of the room server (design 6.1: 30 s). */
export class RoomHealth {
  private cached?: { at: number; verdict: { ok: true } | { ok: false; reason: string } };
  constructor(
    private readonly rooms: MediaRoomProvider | undefined,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  /** Undefined when no room provider is composed. */
  async check(): Promise<{ ok: true } | { ok: false; reason: string } | undefined> {
    if (!this.rooms) return undefined;
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.verdict;
    let verdict: { ok: true } | { ok: false; reason: string };
    try {
      verdict = await this.rooms.health(AbortSignal.timeout(3_000));
    } catch (error) {
      verdict = { ok: false, reason: error instanceof Error ? error.message : 'unreachable' };
    }
    this.cached = { at: this.now(), verdict };
    return verdict;
  }

  /** Forget the verdict (a failed accept proves the cache wrong). */
  invalidate(): void {
    this.cached = undefined;
  }
}
