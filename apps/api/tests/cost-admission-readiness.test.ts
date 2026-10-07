import { AgentConfig } from '@winsendotai/ovo-contracts';
import type { FxVersion, PriceCardVersion } from '@winsendotai/ovo-plugin-ledger';
import type { AgentDraft, ControlStore } from '@winsendotai/ovo-plugin-storage';
import { describe, expect, it } from 'vitest';
import { fixture } from '../../../packages/session-host/tests/compat-support.ts';
import { costAdmissionIssues, type CostAdmissionLedger } from '../src/cost-admission-readiness.ts';
import { liveReadiness } from '../src/live-readiness.ts';
import type { InfrastructureService } from '../src/infrastructure-types.ts';

const card = (id: string, meter: string, extra: Partial<PriceCardVersion> = {}) =>
  ({
    id,
    version: 'v1',
    provider: meter.split('.')[0]!,
    unit: 'audio_seconds',
    currency: 'INR',
    minorUnitsPerBlock: '1',
    blockQuantity: '1',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    provenance: 'fixture',
    ...extra,
  }) satisfies PriceCardVersion;

const usdInr: FxVersion = {
  id: 'usd-inr',
  version: '2026-10',
  baseCurrency: 'USD',
  quoteCurrency: 'INR',
  rateNumerator: '8345',
  rateDenominator: '100',
  effectiveAt: '2026-10-01T00:00:00.000Z',
  provenance: 'fixture',
};

function ledger(cards: PriceCardVersion[], fx: FxVersion[] = [usdInr]): CostAdmissionLedger {
  return {
    getPriceCard: async (id, version) =>
      cards.find((row) => row.id === id && row.version === version),
    getFxVersion: async (id, version) => fx.find((row) => row.id === id && row.version === version),
  };
}

/** The fixture agent priced the way the 2026-10-07 live release was: USD carrier, INR speech. */
function pricedAgent(carrier: Record<string, string> = { fxId: 'usd-inr', fxVersion: '2026-10' }) {
  const base = fixture();
  const config = AgentConfig.parse({
    ...base.config,
    costPolicy: {
      budgetId: 'budget',
      reservationPaise: '5000',
      maxCallSeconds: 300,
      priceCards: {
        'carrier.usage': { id: 'twilio-voice', version: 'v1', ...carrier },
        'stt.usage': { id: 'stt-card', version: 'v1' },
        'tts.usage': { id: 'tts-card', version: 'v1' },
        'llm.usage': { id: 'llm-card', version: 'v1' },
      },
    },
  });
  return { config, selections: base.selections!, registry: base.registry };
}

const stored = [
  card('twilio-voice', 'carrier.usage', { currency: 'USD' }),
  card('stt-card', 'stt.usage'),
  card('tts-card', 'tts.usage'),
  card('llm-card', 'llm.usage'),
];

const draft = (config: AgentDraft['config']): AgentDraft => ({
  id: 'agent',
  workspaceId: 'workspace',
  draftVersion: 1,
  config,
  createdAt: '',
  updatedAt: '',
});
const store = {
  getProviderBinding: async () => ({ credentialId: 'credential', environment: 'live' }),
  getCredential: async () => ({ status: 'active', environment: 'live', permittedAgentIds: [] }),
} as unknown as ControlStore;
const readyInfrastructure = {
  organizationId: 'workspace',
  snapshot: async () => ({ installation: { status: 'ready', reasons: [], enabled: true } }),
} as unknown as InfrastructureService;

describe('live readiness runs the cost checks admission runs', () => {
  it('stays live-ready for a release admission accepts', async () => {
    const agent = pricedAgent();
    expect(await costAdmissionIssues({ ...agent, ledger: ledger(stored) })).toEqual([]);
    const result = await liveReadiness(
      draft(agent.config),
      store,
      agent.registry,
      agent.selections,
      readyInfrastructure,
      undefined,
      undefined,
      ledger(stored),
    );
    expect(result.liveBlockers).toEqual([]);
    expect(result.liveReady).toBe(true);
  });

  // Outage 1, 2026-10-07: readiness said liveReady while every inbound call was refused with
  // "Cost meter requires immutable FX: twilio.carrier.audio_seconds".
  it('is not live-ready when a USD card is referenced without its FX version', async () => {
    const agent = pricedAgent({});
    const result = await liveReadiness(
      draft(agent.config),
      store,
      agent.registry,
      agent.selections,
      readyInfrastructure,
      undefined,
      undefined,
      ledger(stored),
    );
    expect(result.liveReady).toBe(false);
    expect(result.liveBlockers).toEqual([
      'Cost meter requires immutable FX: carrier.usage (the USD price card needs fxId and fxVersion of a USD-INR FX version)',
    ]);
  });

  // Outage 2, 2026-10-07: "Cost price version is unavailable: openai.inference.web_search_calls",
  // the web-search card referenced before it was imported.
  it('is not live-ready when a referenced price card version is not in the ledger', async () => {
    const agent = pricedAgent();
    agent.config.costPolicy!.priceCards['openai.inference.web_search_calls'] = {
      id: 'openai-web-search-calls',
      version: '2026-10-07',
    };
    const result = await liveReadiness(
      draft(agent.config),
      store,
      agent.registry,
      agent.selections,
      readyInfrastructure,
      undefined,
      undefined,
      ledger(stored),
    );
    expect(result.liveReady).toBe(false);
    expect(result.liveBlockers).toEqual([
      'Cost price version is unavailable: openai.inference.web_search_calls (price card openai-web-search-calls version 2026-10-07 is not in the ledger; import it or fix the reference)',
    ]);
  });

  it('names an FX version that is missing, converts another currency, or is half-set', async () => {
    const agent = pricedAgent({ fxId: 'usd-inr', fxVersion: '2026-11' });
    agent.config.costPolicy!.priceCards['stt.usage'] = {
      id: 'stt-card',
      version: 'v1',
      fxId: 'usd-inr',
      fxVersion: '2026-10',
    };
    agent.config.costPolicy!.priceCards['tts.usage'] = {
      id: 'tts-eur',
      version: 'v1',
      fxId: 'usd-inr',
      fxVersion: '2026-10',
    };
    agent.config.costPolicy!.priceCards['llm.usage'] = {
      id: 'llm-usd',
      version: 'v1',
      fxId: 'usd-inr',
    };
    const issues = await costAdmissionIssues({
      ...agent,
      ledger: ledger([
        ...stored,
        card('tts-eur', 'tts.usage', { currency: 'EUR' }),
        card('llm-usd', 'llm.usage', { currency: 'USD' }),
      ]),
    });
    expect(issues.map((issue) => [issue.field, issue.message])).toEqual([
      [
        'carrier.usage',
        'Cost FX version does not match price currency: carrier.usage (FX usd-inr version 2026-11 is not in the ledger; the card is priced in USD)',
      ],
      ['stt.usage', 'INR cost meter must not include FX: stt.usage (remove fxId and fxVersion)'],
      [
        'tts.usage',
        'Cost FX version does not match price currency: tts.usage (FX usd-inr version 2026-10 converts USD to INR; the card is priced in EUR)',
      ],
      ['llm.usage', 'Cost FX reference is incomplete: llm.usage (set both fxId and fxVersion)'],
    ]);
    expect(issues.every((issue) => issue.severity === 'error' && issue.stage === 'live')).toBe(
      true,
    );
  });

  it('refuses a card priced for another model than the binding runs, as admission does', async () => {
    const agent = pricedAgent();
    const issues = await costAdmissionIssues({
      ...agent,
      ledger: ledger(
        stored.map((row) => (row.id === 'llm-card' ? { ...row, model: 'gpt-4o-mini' } : row)),
      ),
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      'price_unknown_for_model: llm.usage (price card llm-card version v1 prices gpt-4o-mini, the binding runs ok)',
    ]);
  });

  it('reports a selected meter with no price reference once', async () => {
    const agent = pricedAgent();
    delete agent.config.costPolicy!.priceCards['tts.usage'];
    expect(
      (await costAdmissionIssues({ ...agent, ledger: ledger(stored) })).map((row) => row.message),
    ).toEqual(['Cost meter is not configured: tts.usage']);
    const result = await liveReadiness(
      draft(agent.config),
      store,
      agent.registry,
      agent.selections,
      readyInfrastructure,
      undefined,
      undefined,
      ledger(stored),
    );
    // compat already says it; readiness does not list the same meter twice.
    expect(result.liveBlockers).toEqual(['No price card covers tts.usage']);
  });

  it('checks nothing without a ledger or a cost policy; admission still does', async () => {
    const agent = pricedAgent({});
    expect(await costAdmissionIssues(agent)).toEqual([]);
    const unpriced = fixture();
    expect(
      await costAdmissionIssues({
        config: unpriced.config,
        selections: unpriced.selections!,
        registry: unpriced.registry,
        ledger: ledger(stored),
      }),
    ).toEqual([]);
  });
});
