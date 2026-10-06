import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Demo price cards come from the dated vendor catalog (OPS-14), never invented values: each entry is
 * the vendor's public list price with its source URL and retrieval date. The API's one-click import
 * stores the selected entries as immutable price cards; nothing here edits a release or a budget.
 */
const CATALOG_URL = new URL(
  '../packages/plugin-ledger/catalog/vendor-prices.json',
  import.meta.url,
);
const IMPORT_BATCH = 50;

export function loadVendorCatalog(url = CATALOG_URL) {
  const parsed = JSON.parse(readFileSync(url, 'utf8'));
  if (!Array.isArray(parsed.entries)) throw new Error('Vendor price catalog has no entries');
  return parsed.entries;
}

/** The entries an import would store, selected by id (all when `ids` is empty), in catalog order. */
export function catalogImportPlan(entries, ids = []) {
  const known = new Set(entries.map((entry) => entry.card.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Not in the price catalog: ${unknown.join(', ')}`);
  const wanted = new Set(ids);
  return entries
    .filter((entry) => !wanted.size || wanted.has(entry.card.id))
    .map((entry) => ({
      id: entry.card.id,
      version: entry.card.version,
      provider: entry.card.provider,
      unit: entry.card.unit,
      currency: entry.card.currency,
      ...(entry.card.model ? { model: entry.card.model } : {}),
      provisional: entry.card.provisional === true,
      meterKeys: [...entry.meterKeys],
      source: `${entry.source.url} (retrieved ${entry.source.retrievedAt})`,
    }));
}

function parseArgs(args) {
  const options = { apply: false, address: undefined, ids: [] };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('Unknown or duplicate option; use --help');
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--api-url' && args[i + 1]) options.address = args[++i];
    else if (flag === '--ids' && args[i + 1])
      options.ids = args[++i]
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    else throw new Error('Unknown or duplicate option; use --help');
  }
  return options;
}

function loopbackOrigin(address) {
  const url = new URL(address);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('--api-url must be a plain loopback origin (127.0.0.1 or [::1])');
  return url;
}

export async function main(args, { fetchImpl = fetch, log = console.log } = {}) {
  if (args.includes('--help')) {
    log(`Preview: node scripts/seed-demo-price-cards.mjs [--ids id1,id2]
Apply: OVO_ADMIN_TOKEN=<local-admin-token> node scripts/seed-demo-price-cards.mjs --apply --api-url http://127.0.0.1:4000 [--ids id1,id2]
Imports dated vendor list prices from packages/plugin-ledger/catalog/vendor-prices.json through
POST /v1/cost/price-catalog/import. Only an explicitly selected loopback API is supported.
USD cards need an FX version (POST /v1/cost/fx-versions) before a cost policy can pin them.`);
    return;
  }
  const options = parseArgs(args);
  const plan = catalogImportPlan(loadVendorCatalog(), options.ids);
  if (!options.apply) {
    log('Vendor catalog import preview; no API requests were made.');
    log(JSON.stringify(plan, null, 2));
    return;
  }
  if (!options.address) throw new Error('--apply requires an explicit --api-url');
  const url = loopbackOrigin(options.address);
  const token = process.env.OVO_ADMIN_TOKEN;
  if (!token) throw new Error('OVO_ADMIN_TOKEN is required for the selected local API');
  for (let start = 0; start < plan.length; start += IMPORT_BATCH) {
    const ids = plan.slice(start, start + IMPORT_BATCH).map((entry) => entry.id);
    const response = await fetchImpl(new URL('/v1/cost/price-catalog/import', url), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 201)
      throw new Error(
        `Catalog import refused (HTTP ${response.status}); earlier batches may exist. No release pins were changed.`,
      );
    await response.arrayBuffer();
    for (const id of ids) log(`Imported ${id}`);
  }
  if (plan.some((entry) => entry.currency !== 'INR'))
    log('Non-INR cards need an FX version before a cost policy can pin them.');
  if (plan.some((entry) => entry.provisional))
    log('Some imported cards are provisional; keep the speculative LLM off until they are firm.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // Avoid transport error details and response bodies: they may contain credentials.
    console.error(
      error instanceof TypeError
        ? 'Catalog import failed: invalid URL or API transport failure'
        : error.message,
    );
    process.exitCode = 1;
  });
}
