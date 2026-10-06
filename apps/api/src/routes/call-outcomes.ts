import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CallRecord, Page } from '@winsendotai/ovo-plugin-storage';
import {
  PostgresCallOutcomeStore,
  type CallOutcomeStore,
} from '@winsendotai/ovo-plugin-storage/outcomes';
import type { CallOutcomeSummary } from '@winsendotai/ovo-contracts';

/**
 * Reads what each call decided (AGT-8). Outcomes live in PostgreSQL beside the control schema; an
 * SQLite installation has no worker writing them and reports `available: false`.
 */
export class CallOutcomeReader {
  private store?: Promise<CallOutcomeStore>;

  /** Opened on first use, so an API that never reads an outcome holds no extra connections. */
  constructor(private readonly opener?: () => Promise<CallOutcomeStore>) {}

  get available(): boolean {
    return this.opener !== undefined;
  }

  open(): Promise<CallOutcomeStore> {
    this.store ??= this.opener!();
    this.store.catch(() => (this.store = undefined));
    return this.store;
  }

  /**
   * The page with each call's outcome summary attached, or `null` where none was recorded. A failed
   * outcome read never fails the call list: the calls are still listed, without outcomes.
   */
  async attach(
    workspaceId: string,
    page: Page<CallRecord>,
    log: FastifyBaseLogger,
  ): Promise<Page<CallRecord & { outcome: CallOutcomeSummary | null }>> {
    let found = new Map<string, CallOutcomeSummary>();
    if (this.available && page.items.length)
      try {
        found = await (
          await this.open()
        ).getMany(
          workspaceId,
          page.items.map((call) => call.id),
        );
      } catch (error) {
        log.warn({ err: error }, 'call outcome summaries unavailable');
      }
    return {
      ...page,
      items: page.items.map((call) => ({ ...call, outcome: found.get(call.id) ?? null })),
    };
  }

  async close(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    if (store) await (await store).close();
  }
}

export function createCallOutcomeReader(options: {
  storageAdapter?: string;
  controlDatabaseUrl?: string;
}): CallOutcomeReader {
  const connectionString = options.controlDatabaseUrl;
  return new CallOutcomeReader(
    options.storageAdapter === 'postgres' && connectionString
      ? () => PostgresCallOutcomeStore.open({ connectionString, maxConnections: 2 })
      : undefined,
  );
}

const OutcomeQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z
    .string()
    .regex(/^\d{1,9}$/)
    .optional(),
});

export function registerCallOutcomeRoute(dependencies: {
  app: FastifyInstance;
  store: { getCall(workspaceId: string, id: string): Promise<CallRecord | undefined> };
  outcomes: CallOutcomeReader;
  requireRole: (request: FastifyRequest, role: 'viewer') => { workspaceId: string };
  Id: z.ZodType<string>;
  error: (reply: FastifyReply, status: number, code: string, message: string) => unknown;
}): void {
  const { app, store, outcomes, requireRole, Id, error } = dependencies;
  /**
   * The call's outcome (disposition, final node, state path, captured variables, tier counts and
   * guardrail counts) and its session events in order: every `turn.route` decision with its intent,
   * confidence and tier, every flow state, disposition and guardrail verdict.
   */
  app.get('/v1/calls/:callId/outcome', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer');
    const { callId } = z.object({ callId: Id }).parse(request.params);
    const query = OutcomeQuery.parse(request.query);
    const call = await store.getCall(principal.workspaceId, callId);
    if (!call) return error(reply, 404, 'not_found', 'Call not found');
    const base = { callId, status: call.status, available: outcomes.available };
    if (!outcomes.available) return { ...base, summary: null, events: [], nextCursor: null };
    const durable = await outcomes.open();
    const [summary, events] = await Promise.all([
      durable.get(principal.workspaceId, callId),
      durable.listEvents(principal.workspaceId, callId, query.limit, query.cursor),
    ]);
    return {
      ...base,
      summary: summary ?? null,
      events: events.items,
      nextCursor: events.nextCursor,
    };
  });
}

/** The outcome route plus the reader the call list attaches summaries with; closed with the app. */
export function registerCallOutcomes(
  dependencies: Omit<Parameters<typeof registerCallOutcomeRoute>[0], 'outcomes'> & {
    options?: Parameters<typeof createCallOutcomeReader>[0];
  },
): CallOutcomeReader {
  const outcomes = createCallOutcomeReader(dependencies.options ?? {});
  dependencies.app.addHook('onClose', () => outcomes.close());
  registerCallOutcomeRoute({ ...dependencies, outcomes });
  return outcomes;
}
