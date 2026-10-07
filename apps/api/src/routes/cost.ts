import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BudgetBody,
  CallParams,
  CatalogImportBody,
  FxVersionBody,
  PageQuery,
  PriceCardBody,
  ReconciliationBody,
  ScenarioBody,
} from './cost-schemas.ts';
import { priceCatalog } from './cost-catalog.ts';
import {
  calculateInrScenario,
  LedgerConflictError,
  VENDOR_PRICE_CATALOG,
  vendorPriceCard,
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

  // OPS-14: the dated vendor price catalog, each entry's state in this ledger (the monthly diff),
  // and a one-click import that stores entries as immutable price cards.
  app.get('/v1/cost/price-catalog', async (request, reply) => {
    requireRole(request, 'viewer');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    return safely(reply, async () => reply.send({ items: await priceCatalog(ledger) }));
  });

  app.post('/v1/cost/price-catalog/import', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const ledger = configuredLedger(dependencies, reply);
    if (!ledger) return;
    const { ids } = CatalogImportBody.parse(request.body);
    const unique = [...new Set(ids)];
    const entries = unique.map((id) => VENDOR_PRICE_CATALOG.find((entry) => entry.card.id === id));
    const unknown = unique.filter((_id, index) => !entries[index]);
    if (unknown.length)
      return failure(
        reply,
        400,
        'validation_error',
        `Not in the price catalog: ${unknown.join(', ')}`,
      );
    return safely(reply, async () => {
      const imported = [];
      for (const entry of entries) {
        const card = await ledger.putPriceCard(vendorPriceCard(entry!));
        await auditMutation(audit, principal, 'cost.price-card.import', 'price-card', card);
        imported.push(card);
      }
      return reply.code(201).send({ items: imported });
    });
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
    // P11: usage is keyed by the worker's media session id, not the call id; the ledger finds the
    // call's sessions through the call id each usage row carries. Media session ids stay private
    // below admin, as in live diagnostics.
    return safely(reply, async () => {
      const { sessionIds, ...cost } = await ledger.getCallCost(principal.workspaceId, callId);
      return reply.send(principal.role === 'admin' ? { ...cost, sessionIds } : cost);
    });
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
