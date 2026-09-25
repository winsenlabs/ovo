import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  calculateInrScenario,
  LedgerConflictError,
  type CostLedgerService,
  type FxVersion,
  type InrScenarioInput,
  type PriceCardVersion,
  type ReconcileUsageInput,
} from '@winsendotai/ovo-plugin-ledger';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';

interface CostPrincipal {
  identityId: string;
  workspaceId: string;
  role: Role;
}

type AuditInput = Parameters<ControlStore['audit']>[0];

export interface CostRouteDependencies {
  app: FastifyInstance;
  ledger?: CostLedgerService;
  controlStore: Pick<ControlStore, 'getCall'>;
  requireRole(request: FastifyRequest, role: Role): CostPrincipal;
  audit(input: AuditInput): Promise<unknown>;
}

const Identifier = z.string().trim().min(1).max(200);
const Provenance = z.string().trim().min(1).max(2_000);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const UnsignedInteger = z.string().regex(/^(0|[1-9]\d{0,59})$/);
const PositiveInteger = UnsignedInteger.refine((value) => value !== '0');
const Decimal = z.string().regex(/^(0|[1-9]\d{0,59})(?:\.\d{1,18})?$/);
const Timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid ISO timestamp');

const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const PriceCardBody = z
  .object({
    id: Identifier,
    version: Identifier,
    provider: Identifier,
    unit: Identifier,
    currency: Currency,
    minorUnitsPerBlock: Decimal,
    blockQuantity: Decimal.refine((value) => value !== '0'),
    effectiveAt: Timestamp,
    provenance: Provenance,
  })
  .strict();

const FxVersionBody = z
  .object({
    id: Identifier,
    version: Identifier,
    baseCurrency: Currency,
    quoteCurrency: z.literal('INR'),
    rateNumerator: UnsignedInteger,
    rateDenominator: PositiveInteger,
    effectiveAt: Timestamp,
    provenance: Provenance,
  })
  .strict();

const FxReference = z
  .object({
    id: Identifier,
    version: Identifier,
    baseCurrency: Currency,
    quoteCurrency: z.literal('INR'),
    rateNumerator: UnsignedInteger,
    rateDenominator: PositiveInteger,
  })
  .strict();

const ScenarioBody = z
  .object({
    targetRevenuePaise: UnsignedInteger,
    durationSeconds: PositiveInteger,
    components: z
      .array(
        z
          .object({
            id: Identifier,
            category: z.enum(['telephony', 'tax', 'speech-generation', 'carrier-media', 'idle']),
            amountMinor: UnsignedInteger,
            currency: Currency,
            assumption: Provenance,
            fx: FxReference.optional(),
          })
          .strict(),
      )
      .min(5)
      .max(50),
    cache: z
      .object({
        generatedUnits: Decimal,
        hitUnits: Decimal,
        generationBilledOnce: z.literal(true),
        carrierMediaStillBilled: z.literal(true),
        assumption: Provenance,
      })
      .strict(),
    marginScope: Provenance,
  })
  .strict();

const ReconciliationBody = z
  .object({
    idempotencyKey: Identifier,
    usageId: Identifier,
    providerInvoiceId: Identifier,
    providerInvoiceLineId: Identifier,
    actualAmountMinor: UnsignedInteger,
    currency: Currency,
    fx: z.object({ id: Identifier, version: Identifier }).strict().optional(),
    occurredAt: Timestamp,
  })
  .strict();

const BudgetBody = z
  .object({
    id: Identifier,
    limitPaise: UnsignedInteger,
    admissionOverspendPaise: UnsignedInteger,
  })
  .strict();

const CallParams = z.object({ callId: Identifier }).strict();

export function registerCostRoutes(dependencies: CostRouteDependencies): void {
  const { app, controlStore, requireRole, audit } = dependencies;

  app.post('/v1/cost/price-cards', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const input = PriceCardBody.parse(request.body) as PriceCardVersion;
    return safely(reply, async () => {
      const card = await ledger.putPriceCard(input);
      await auditMutation(audit, principal, 'cost.price-card.put', 'price-card', card);
      return reply.code(201).send(card);
    });
  });

  app.get('/v1/cost/price-cards', async (request, reply) => {
    requireRole(request, 'viewer');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const query = PageQuery.parse(request.query);
    return safely(reply, async () =>
      reply.send(await ledger.listPriceCards(query.limit, query.cursor)),
    );
  });

  app.post('/v1/cost/fx-versions', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const input = FxVersionBody.parse(request.body) as FxVersion;
    return safely(reply, async () => {
      const fx = await ledger.putFxVersion(input);
      await auditMutation(audit, principal, 'cost.fx-version.put', 'fx-version', fx);
      return reply.code(201).send(fx);
    });
  });

  app.get('/v1/cost/fx-versions', async (request, reply) => {
    requireRole(request, 'viewer');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const query = PageQuery.parse(request.query);
    return safely(reply, async () =>
      reply.send(await ledger.listFxVersions(query.limit, query.cursor)),
    );
  });

  app.get('/v1/cost/budgets', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const query = PageQuery.parse(request.query);
    return safely(reply, async () =>
      reply.send(await ledger.listBudgets(principal.workspaceId, query.limit, query.cursor)),
    );
  });

  app.post('/v1/cost/budgets', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const body = BudgetBody.parse(request.body);
    return safely(reply, async () => {
      const budget = await ledger.createBudget({ ...body, workspaceId: principal.workspaceId });
      await audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'cost.budget.put',
        resourceType: 'budget',
        resourceId: budget.id,
        payload: {
          limitPaise: budget.limitPaise,
          admissionOverspendPaise: budget.admissionOverspendPaise,
        },
      });
      return reply.code(201).send(budget);
    });
  });

  app.post('/v1/cost/scenario', async (request, reply) => {
    requireRole(request, 'viewer');
    const input = ScenarioBody.parse(request.body) as InrScenarioInput;
    return safely(reply, async () => reply.send(calculateInrScenario(input)));
  });

  app.get('/v1/calls/:callId/cost', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const { callId } = CallParams.parse(request.params);
    const call = await controlStore.getCall(principal.workspaceId, callId);
    if (!call) return failure(reply, 404, 'not_found', 'Call not found');
    return safely(reply, async () =>
      reply.send(await ledger.getSessionCost(principal.workspaceId, callId)),
    );
  });

  app.post('/v1/cost/reconciliation', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const body = ReconciliationBody.parse(request.body);
    const input: ReconcileUsageInput = { ...body, workspaceId: principal.workspaceId };
    return safely(reply, async () => {
      const result = await ledger.reconcileUsage(input);
      await audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'cost.reconciliation.append',
        resourceType: 'usage',
        resourceId: input.usageId,
        payload: {
          providerInvoiceId: input.providerInvoiceId,
          providerInvoiceLineId: input.providerInvoiceLineId,
          correctionId: result.correctionId,
        },
      });
      return reply.code(201).send(result);
    });
  });
}

function configuredLedger(
  dependencies: CostRouteDependencies,
  reply: FastifyReply,
): CostLedgerService | undefined {
  if (dependencies.ledger) return dependencies.ledger;
  failure(reply, 503, 'cost_ledger_unavailable', 'Cost ledger is not configured');
  return undefined;
}

async function safely(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LedgerConflictError)
      return failure(reply, 409, 'ledger_conflict', 'Request conflicts with existing ledger data');
    if (error instanceof TypeError || error instanceof RangeError)
      return failure(reply, 400, 'validation_error', 'Ledger input is invalid');
    if (
      error instanceof Error &&
      ['Usage charge not found', 'Budget not found', 'Reservation not found'].includes(
        error.message,
      )
    )
      return failure(reply, 404, 'not_found', 'Ledger resource not found');
    throw error;
  }
}

function failure(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

async function auditMutation(
  audit: CostRouteDependencies['audit'],
  principal: CostPrincipal,
  action: string,
  resourceType: string,
  resource: { id: string; version: string },
): Promise<void> {
  await audit({
    workspaceId: principal.workspaceId,
    actorId: principal.identityId,
    action,
    resourceType,
    resourceId: resource.id,
    payload: { version: resource.version },
  });
}
