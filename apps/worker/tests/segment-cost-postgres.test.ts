import { randomUUID } from 'node:crypto';
import { PostgresCostLedger } from '@winsendotai/ovo-plugin-ledger';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorkerCostPolicyAttachment } from '../src/cost-policy.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

/** Transfer design 7.11 on the real ledger (005): a routed call's usage by segment. */
describe.skipIf(!postgresUrl)('routed call cost by segment on the PostgreSQL ledger', () => {
  const id = randomUUID();
  const [workspace, call, session, budget] = ['workspace', 'call', 'media', 'budget'].map(
    (name) => `${name}-${id}`,
  );
  let ledger: PostgresCostLedger;

  beforeAll(async () => {
    ledger = new PostgresCostLedger({ connectionString: postgresUrl! });
    await ledger.migrate();
    await ledger.putPriceCard({
      id: `tts-${id}`,
      version: 'v1',
      provider: 'fixture',
      unit: 'characters',
      currency: 'INR',
      minorUnitsPerBlock: '1',
      blockQuantity: '1',
      effectiveAt: '2026-09-20T00:00:00.000Z',
      provenance: 'fixture price publication',
    });
    await ledger.createBudget({
      id: budget!,
      workspaceId: workspace!,
      limitPaise: '100000',
      admissionOverspendPaise: '0',
    });
  });

  afterAll(async () => {
    await ledger?.close();
  });

  it("tags each segment's usage and sums the call by segment, call-level usage apart", async () => {
    const attachment = createWorkerCostPolicyAttachment({
      ledger,
      policy: {
        budgetId: budget!,
        reservationPaise: '50000',
        maxCallSeconds: 600,
        priceCards: { 'fixture.streaming-tts.characters': { id: `tts-${id}`, version: 'v1' } },
      },
      workspaceId: workspace!,
      sessionId: session!,
      callId: call!,
      sessionStartedAt: '2026-10-15T00:00:00.000Z',
      requestTermination: vi.fn(),
    });
    expect(await attachment.reserveBeforeAdmission()).toMatchObject({ admitted: true });
    const usage = (requestId: string, quantity: string) => ({
      provider: 'fixture',
      operation: 'streaming-tts' as const,
      requestId,
      elapsedMs: 20,
      quantity,
      unit: 'characters' as const,
      state: 'estimated' as const,
    });
    attachment.providerUsage(usage('router-1', '10'), 0);
    attachment.providerUsage(usage('agent-1', '20'), 1);
    attachment.providerUsage(usage('agent-2', '5'), 1);
    // Hold-voice generation is call-level: no segment.
    attachment.providerUsage(usage('hold-line', '7'));
    await attachment.finalizeKnownUsage();
    const rows = await ledger.pool.query(
      `SELECT segment_index, sum(quantity::numeric)::text AS quantity FROM ovo_cost_native_usage
        WHERE session_id = $1 GROUP BY segment_index ORDER BY segment_index NULLS FIRST`,
      [session],
    );
    expect(rows.rows).toEqual([
      { segment_index: null, quantity: '7' },
      { segment_index: 0, quantity: '10' },
      { segment_index: 1, quantity: '25' },
    ]);
    const cost = await ledger.getCallCost(workspace!, call!);
    expect(cost.segments.map((segment) => [segment.index, segment.totalPaise])).toEqual([
      [null, '7'],
      [0, '10'],
      [1, '25'],
    ]);
  });
});
