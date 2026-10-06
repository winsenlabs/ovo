import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface CatalogEntry {
  card: { id: string; version: string };
  meterKeys: string[];
  source: { url: string; retrievedAt: string };
}
const VENDOR_PRICE_CATALOG = (
  JSON.parse(
    readFileSync(
      new URL('../../packages/plugin-ledger/catalog/vendor-prices.json', import.meta.url),
      'utf8',
    ),
  ) as { entries: CatalogEntry[] }
).entries;

const script = () =>
  import(new URL('../seed-demo-price-cards.mjs', import.meta.url).href) as Promise<{
    loadVendorCatalog(): typeof VENDOR_PRICE_CATALOG;
    catalogImportPlan(
      entries: typeof VENDOR_PRICE_CATALOG,
      ids?: string[],
    ): Array<{ id: string; version: string; currency: string; source: string; model?: string }>;
    main(
      args: string[],
      io: { fetchImpl: typeof fetch; log: (line: string) => void },
    ): Promise<void>;
  }>;

describe('demo price cards come from the dated vendor catalog (Wave 2 deferred #8)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('plans the catalog entries, with no invented prices, and makes no requests on import', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No requests'));
    try {
      const { loadVendorCatalog, catalogImportPlan } = await script();
      const plan = catalogImportPlan(loadVendorCatalog());
      expect(fetch).not.toHaveBeenCalled();
      expect(plan.map((entry) => [entry.id, entry.version])).toEqual(
        VENDOR_PRICE_CATALOG.map((entry) => [entry.card.id, entry.card.version]),
      );
      for (const entry of plan) {
        expect(entry.id).not.toMatch(/^demo-illustrative-/);
        expect(entry.source).toMatch(/^https:\/\/.+ \(retrieved \d{4}-\d{2}-\d{2}\)$/);
      }
      expect(plan.find((entry) => entry.id === 'openai-gpt-6-luna-output')).toMatchObject({
        model: 'gpt-6-luna',
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it('selects entries by id and refuses an id the catalog does not hold', async () => {
    const { loadVendorCatalog, catalogImportPlan } = await script();
    const entries = loadVendorCatalog();
    expect(
      catalogImportPlan(entries, ['elevenlabs-tts-flash-v2-5']).map((entry) => entry.id),
    ).toEqual(['elevenlabs-tts-flash-v2-5']);
    expect(() => catalogImportPlan(entries, ['demo-illustrative-openai-characters'])).toThrow(
      'Not in the price catalog: demo-illustrative-openai-characters',
    );
  });

  it('applies through the catalog import route on an explicit loopback API only', async () => {
    const { main } = await script();
    const fetchImpl = vi.fn(async () => new Response('{"items":[]}', { status: 201 }));
    const log = vi.fn();
    vi.stubEnv('OVO_ADMIN_TOKEN', 'local-token');
    await main(
      ['--apply', '--api-url', 'http://127.0.0.1:4000', '--ids', 'elevenlabs-tts-flash-v2-5'],
      { fetchImpl: fetchImpl as unknown as typeof fetch, log },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('http://127.0.0.1:4000/v1/cost/price-catalog/import');
    expect(JSON.parse(String(init.body))).toEqual({ ids: ['elevenlabs-tts-flash-v2-5'] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FX version'));
    await expect(
      main(['--apply', '--api-url', 'https://api.example.com'], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log,
      }),
    ).rejects.toThrow('loopback');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
