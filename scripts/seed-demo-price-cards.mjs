import { pathToFileURL } from 'node:url';

const label = 'ILLUSTRATIVE — NOT A QUOTE';

/** Pure preview data. These invented prices are neither vendor quotes nor automatic release pins. */
export function demoPriceCards() {
  const meters = [
    ['deepgram', 'audio_seconds'],
    ...[
      'characters',
      'input_tokens',
      'output_tokens',
      'audio_output_tokens',
      'uncached_input_tokens',
      'cache_read_input_tokens',
      'cache_write_input_tokens',
    ].map((unit) => ['openai', unit]),
  ];
  return meters.map(([provider, unit]) => ({
    id: `demo-illustrative-${provider}-${unit}`,
    version: `${label} v1`,
    provider,
    unit,
    currency: 'INR',
    minorUnitsPerBlock: '100',
    blockQuantity: '1000',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    provenance: `${label}. Invented demo-only values: 100 paise per 1000 native units. Not current vendor pricing; do not use for spending decisions.`,
  }));
}

async function main(args) {
  if (args.includes('--help')) {
    console.log(`Preview: node scripts/seed-demo-price-cards.mjs
Apply manually: OVO_ADMIN_TOKEN=<local-admin-token> node scripts/seed-demo-price-cards.mjs --apply --api-url http://127.0.0.1:4000
${label}. Only an explicitly selected loopback API is supported. No release/budget configuration is changed.`);
    return;
  }
  let apply = false;
  let address;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--api-url' && !address && args[i + 1]) address = args[++i];
    else throw new Error('Unknown or duplicate option; use --help');
  }
  const cards = demoPriceCards();
  if (!apply) {
    console.log(`${label}. Preview only; no API requests were made.`);
    console.log(JSON.stringify(cards, null, 2));
    return;
  }
  if (!address) throw new Error('--apply requires an explicit --api-url');
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
  const token = process.env.OVO_ADMIN_TOKEN;
  if (!token) throw new Error('OVO_ADMIN_TOKEN is required for the selected local API');
  console.log(label);
  for (const card of cards) {
    const response = await fetch(new URL('/v1/cost/price-cards', url), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(card),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 201)
      throw new Error(
        `Price-card write refused (HTTP ${response.status}); earlier cards may exist. No release pins were changed.`,
      );
    await response.arrayBuffer();
    console.log(`Stored ${card.id} / ${card.version}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // Avoid transport error details and response bodies: they may contain credentials.
    console.error(
      error instanceof TypeError
        ? 'Demo seed failed: invalid URL or API transport failure'
        : error.message,
    );
    process.exitCode = 1;
  });
}
