// Provider-name gate (§13.4): no vendor names in host and shared code. Per-file counts ratchet;
// migrations, `legacyPaths` declarations and docs are allowlisted.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { ratchet } from './lib/count-gate.mjs';
import { finish, isTestFile, parseArgs, rootOf, under, walkFiles } from './lib/gate-support.mjs';

const NAMES = /deepgram|assemblyai|sarvam|openai|twilio|exotel|plivo|livekit/gi;
const HOST_PACKAGES = [
  'runtime',
  'contracts',
  'session-host',
  'plugin-media',
  'plugin-operations',
  'plugin-orchestration',
  'plugin-ledger',
  'plugin-observability',
  'plugin-voice',
];

const args = parseArgs();
const root = rootOf(args);

async function scanRoots() {
  const roots = HOST_PACKAGES.map((name) => under(root, `packages/${name}/src`));
  const apps = under(root, 'apps');
  if (existsSync(apps))
    for (const entry of await readdir(apps, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'console')
        roots.push(
          ...['app', 'components', 'features', 'lib'].map((sub) => `${apps}/console/${sub}`),
        );
      else roots.push(`${apps}/${entry.name}/src`);
    }
  return roots.filter((dir) => existsSync(dir));
}

// §13.4 allowlists `legacyPaths`: the carrier-ingress compatibility routes that still spell a
// vendor's old URL path. Only a line that actually declares or assigns that exact property is
// exempt — merely mentioning the token (`legacyPathsForTwilio`, a trailing `// legacyPaths`
// comment) used to silence the whole line and hide every provider name on it.
const LEGACY_PATHS_DECLARATION = /(?:^|[^\w$])legacyPaths\??\s*[:=]/;

const counts = new Map();
let scanned = 0;
for (const dir of await scanRoots()) {
  const files = await walkFiles(
    dir,
    (f) => /\.[cm]?[jt]sx?$/.test(f) && !f.endsWith('.d.ts') && !isTestFile(f),
    { extraSkip: ['migrations'] },
  );
  for (const file of files) {
    scanned += 1;
    let count = 0;
    for (const line of (await readFile(file, 'utf8')).split('\n'))
      if (!LEGACY_PATHS_DECLARATION.test(line)) count += line.match(NAMES)?.length ?? 0;
    counts.set(file, count);
  }
}

const result = await ratchet(args, {
  fileName: 'provider-names.json',
  key: 'providerNames',
  counts,
  what: 'provider-name occurrences',
});
finish('provider-names', { ...result, summary: `scanned ${scanned} host and shared files.` });
