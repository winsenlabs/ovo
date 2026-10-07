import { randomUUID } from 'node:crypto';
import type { UsageMeter } from '@winsendotai/ovo-contracts';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import {
  PostgresCostLedger,
  type FxVersion,
  type PriceCardVersion,
} from '@winsendotai/ovo-plugin-ledger';
import { describe, expect, it, vi } from 'vitest';
import { createPrerenderMeter } from '../src/speech-cache-meter.ts';
import { fixtureRelease } from './speech-cache-harness.ts';

const silent = createLogger({}, { sink: () => undefined });

const ttsCard: PriceCardVersion = {
  id: 'elevenlabs-tts-flash-v2-5',
  version: '2026-10-06',
  provider: 'elevenlabs',
  unit: 'characters',
  currency: 'USD',
  minorUnitsPerBlock: '5',
  blockQuantity: '1000',
  effectiveAt: '2026-10-06T00:00:00.000Z',
  provenance: 'fixture: 0.05 USD per 1K characters',
};
const usdInr: FxVersion = {
  id: 'usd-inr',
  version: '2026-10',
  baseCurrency: 'USD',
  quoteCurrency: 'INR',
  rateNumerator: '8345',
  rateDenominator: '100',
  effectiveAt: '2026-10-01T00:00:00.000Z',
  provenance: 'fixture FX',
};

function meter(requestId: string, quantity = '151'): UsageMeter {
  return {
    provider: 'elevenlabs',
    operation: 'tts',
    unit: 'characters',
    quantity,
    state: 'estimated',
    requestId,
    elapsedMs: 300,
  };
}

/** A release priced like eb35ee47 on 2026-10-07: its TTS card named no FX, its carrier card did. */
function release(
  tts: Record<string, string> = {},
  extra: Record<string, Record<string, string>> = {},
) {
  return fixtureRelease(
    {
      speechCache: { enabled: true },
      costPolicy: {
        budgetId: 'budget',
        reservationPaise: '5000',
        maxCallSeconds: 300,
        priceCards: {
          'elevenlabs.streaming-tts.characters': {
            id: ttsCard.id,
            version: ttsCard.version,
            ...tts,
          },
          'twilio.carrier.audio_seconds': {
            id: 'twilio-voice',
            version: '2026-10-06',
            fxId: 'usd-inr',
            fxVersion: '2026-10',
          },
          ...extra,
        },
      },
    },
    { id: `release-${randomUUID()}` },
  );
}

function fakeLedger(fx: FxVersion[] = [usdInr], cards: PriceCardVersion[] = [ttsCard]) {
  return {
    recordUsage: vi.fn(async () => ({}) as never),
    getPriceCard: vi.fn(async (id: string, version: string) =>
      cards.find((card) => card.id === id && card.version === version),
    ),
    getFxVersion: vi.fn(async (id: string, version: string) =>
      fx.find((row) => row.id === id && row.version === version),
    ),
  };
}

describe('pre-render metering FX', () => {
  it('converts a USD card the release names without FX with the release FX version', async () => {
    const ledger = fakeLedger();
    const priced = release();
    const prerender = createPrerenderMeter(priced, ledger, silent);
    prerender.sink(meter('r1'));
    prerender.sink(meter('r2'));
    expect(await prerender.flush()).toEqual({ recorded: 2, unpriced: [], failed: 0 });
    expect(ledger.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        priceCard: { id: ttsCard.id, version: ttsCard.version },
        fx: { id: 'usd-inr', version: '2026-10' },
      }),
    );
    // Resolved once per meter key, not per rendered line.
    expect(ledger.getPriceCard).toHaveBeenCalledOnce();
  });

  it('keeps a reference own FX and adds none to an INR card', async () => {
    const own = fakeLedger([usdInr, { ...usdInr, version: '2026-09' }]);
    const meterOwn = createPrerenderMeter(
      release({ fxId: 'usd-inr', fxVersion: '2026-09' }),
      own,
      silent,
    );
    meterOwn.sink(meter('r1'));
    await meterOwn.flush();
    expect(own.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ fx: { id: 'usd-inr', version: '2026-09' } }),
    );
    expect(own.getPriceCard).not.toHaveBeenCalled();

    const inr = fakeLedger([usdInr], [{ ...ttsCard, currency: 'INR' }]);
    const meterInr = createPrerenderMeter(release(), inr, silent);
    meterInr.sink(meter('r1'));
    await meterInr.flush();
    expect(inr.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ fx: undefined }));
  });

  it('does not guess between two FX versions for the same currency', async () => {
    const ledger = fakeLedger([usdInr, { ...usdInr, version: '2026-09' }]);
    const priced = release(
      {},
      {
        'openai.inference.input_tokens': {
          id: 'openai-input',
          version: 'v1',
          fxId: 'usd-inr',
          fxVersion: '2026-09',
        },
      },
    );
    const prerender = createPrerenderMeter(priced, ledger, silent);
    prerender.sink(meter('r1'));
    await prerender.flush();
    expect(ledger.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ fx: undefined }));
  });

  const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
  // The live failure: every pre-render charge for eb35ee47 failed with this error, so the
  // release's synthesis was never billed.
  it.skipIf(!postgresUrl)(
    'records what the ledger refused with "Non-INR pricing requires an explicit immutable FX version"',
    async () => {
      // A schema of its own: other suites page the shared ledger's cards and FX versions.
      const schema = `prerender_fx_${randomUUID().replaceAll('-', '')}`;
      const ledger = new PostgresCostLedger({
        connectionString: postgresUrl,
        options: `-c search_path=${schema}`,
      });
      try {
        await ledger.pool.query(`CREATE SCHEMA ${schema}`);
        await ledger.migrate();
        await ledger.putPriceCard(ttsCard);
        await ledger.putFxVersion(usdInr);
        const priced = release();
        const unaided = createPrerenderMeter(
          priced,
          { recordUsage: (input) => ledger.recordUsage(input) },
          silent,
        );
        unaided.sink(meter(`unaided-${randomUUID()}`));
        expect(await unaided.flush()).toMatchObject({ recorded: 0, failed: 1 });

        const prerender = createPrerenderMeter(priced, ledger, silent);
        prerender.sink(meter(`r-${randomUUID()}`, '151'));
        expect(await prerender.flush()).toEqual({ recorded: 1, unpriced: [], failed: 0 });
        // 151 characters at 5 US cents per 1K = 0.755 cents = 63.0 paise.
        expect(
          await ledger.getSessionCost(priced.workspaceId, `prerender:${priced.id}`),
        ).toMatchObject({ totalPaise: '63' });
      } finally {
        await ledger.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await ledger.close();
      }
    },
  );
});
