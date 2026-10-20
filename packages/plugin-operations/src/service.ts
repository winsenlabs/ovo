import { Pool } from 'pg';
import type { PreferenceProvider } from '@winsendotai/ovo-contracts';
import { CampaignService } from './campaign.ts';
import type { ComplianceService } from './compliance/service.ts';
import { OperationsCallRegistry } from './calls.ts';
import { PostgresRoutingService, type RoutingService } from './routing/service.ts';
import { normalizePhoneNumber } from './csv.ts';
import { HandoffService } from './handoff.ts';
import type { HumanQueueService } from './human-queue/service.ts';
import { PostgresHumanQueueService } from './human-queue/postgres/service.ts';
import { InboundGatewayAdmissionService } from './inbound-gateway.ts';
import { InboundRouteService } from './inbound-routes.ts';
import { InboundService } from './inbound.ts';
import { runOperationsMigrations } from './migrations.ts';
import { OperationsOutbox } from './outbox.ts';
import { CampaignRetryService } from './retries.ts';
import type { HandoffProviderPort, OperationsServiceConfig } from './types.ts';

export interface OperationsService {
  readonly organizationId: string;
  readonly config: OperationsServiceConfig;
  readonly campaigns: CampaignService;
  readonly retries: CampaignRetryService;
  readonly compliance: ComplianceService;
  readonly inbound: InboundService;
  readonly inboundGateway: InboundGatewayAdmissionService;
  readonly inboundRoutes: InboundRouteService;
  readonly handoffs: HandoffService;
  readonly outbox: OperationsOutbox;
  readonly calls: OperationsCallRegistry;
  /** Wave 15 pools, points, releases and member claims. */
  readonly routing: RoutingService;
  /** Wave 17 human queues: queues, operators, tickets. */
  readonly humanQueues: HumanQueueService;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export class PostgresOperationsService implements OperationsService {
  readonly organizationId: string;
  readonly config: OperationsServiceConfig;
  readonly campaigns: CampaignService;
  readonly retries: CampaignRetryService;
  readonly compliance: ComplianceService;
  readonly inbound: InboundService;
  readonly inboundGateway: InboundGatewayAdmissionService;
  readonly inboundRoutes: InboundRouteService;
  readonly handoffs: HandoffService;
  readonly outbox: OperationsOutbox;
  readonly calls: OperationsCallRegistry;
  readonly routing: PostgresRoutingService;
  readonly humanQueues: PostgresHumanQueueService;

  private readonly ownsPool: boolean;
  private closePromise?: Promise<void>;
  readonly pool: Pool;

  constructor(input: {
    organizationId: string;
    handoffProvider?: HandoffProviderPort;
    pool?: Pool;
    connectionString?: string;
    maxConnections?: number;
    config?: OperationsServiceConfig;
    /** DND scrub providers beside the built-in manual upload (vendor plugins). */
    preferenceProviders?: readonly PreferenceProvider[];
  }) {
    if (!input.organizationId.trim()) throw new Error('organizationId is required');
    if (!input.pool && !input.connectionString)
      throw new Error('PostgreSQL pool or connectionString is required');
    const maxConnections = input.maxConnections ?? 5;
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 20)
      throw new Error('Operations maxConnections must be an integer between 1 and 20');
    this.pool =
      input.pool ??
      new Pool({
        connectionString: input.connectionString,
        max: maxConnections,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
      });
    this.organizationId = input.organizationId;
    this.ownsPool = !input.pool;
    this.config = Object.freeze({
      permittedFromNumbers: Object.freeze(
        [...new Set((input.config?.permittedFromNumbers ?? []).map(normalizePhoneNumber))].sort(),
      ),
      liveEnabled: input.config?.liveEnabled === true,
      routingEnabled: input.config?.routingEnabled === true,
      humanQueueEnabled: input.config?.humanQueueEnabled === true,
      ...(input.config?.humanQueuePresenceTtlSeconds
        ? { humanQueuePresenceTtlSeconds: input.config.humanQueuePresenceTtlSeconds }
        : {}),
    });
    this.campaigns = new CampaignService(
      this.pool,
      input.organizationId,
      input.preferenceProviders,
    );
    this.compliance = this.campaigns.compliance;
    this.retries = new CampaignRetryService(this.pool, input.organizationId, this.compliance.gate);
    this.inbound = new InboundService(this.pool, input.organizationId);
    this.inboundGateway = new InboundGatewayAdmissionService(
      this.pool,
      input.organizationId,
      {
        enabled: this.config.liveEnabled === true,
        permittedFromNumbers: this.config.permittedFromNumbers,
      },
      this.config.routingEnabled === true,
    );
    this.inboundRoutes = new InboundRouteService(this.pool, input.organizationId);
    this.handoffs = new HandoffService(this.pool, input.organizationId, input.handoffProvider);
    this.outbox = new OperationsOutbox(this.pool);
    this.calls = new OperationsCallRegistry(this.pool, input.organizationId);
    this.routing = new PostgresRoutingService(
      this.pool,
      input.organizationId,
      this.config.routingEnabled === true,
    );
    this.humanQueues = new PostgresHumanQueueService(this.pool, input.organizationId, {
      enabled: this.config.humanQueueEnabled === true,
      ...(this.config.humanQueuePresenceTtlSeconds
        ? { presenceTtlSeconds: this.config.humanQueuePresenceTtlSeconds }
        : {}),
    });
  }

  migrate(): Promise<void> {
    return runOperationsMigrations(this.pool);
  }

  async close(): Promise<void> {
    if (!this.ownsPool) return;
    this.closePromise ??= this.pool.end();
    await this.closePromise;
  }
}
