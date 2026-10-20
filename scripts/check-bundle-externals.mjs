#!/usr/bin/env node
// Builds every app bundle and fails when it imports a package its build marks external but the
// app does not declare as a direct dependency. Images install apps with `pnpm deploy --prod`, which
// places only direct dependencies in node_modules, so such an import crashes the container on boot
// with ERR_MODULE_NOT_FOUND: @livekit/rtc-node on 2026-10-05, @livekit/protocol on 2026-10-20.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const apps = ['api', 'worker', 'media-gateway', 'dispatcher'];
/** Native add-ons their callers load lazily inside try/catch; absent is a supported state. */
const OPTIONAL = new Set(['pg-native', 'sharp', 'onnxruntime-node']);
const NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*/;
let failed = false;

for (const app of apps) {
  const dir = join(root, 'apps', app);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const patterns = [...manifest.scripts.build.matchAll(/--external:(\S+)/g)].map(
    ([, pattern]) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
  );
  execFileSync('pnpm', ['run', 'build'], { cwd: dir, stdio: 'ignore' });
  const imported = new Set();
  for (const file of readdirSync(join(dir, 'dist')).filter((name) => /\.(c?js|mjs)$/.test(name))) {
    const text = readFileSync(join(dir, 'dist', file), 'utf8');
    for (const [, specifier] of text.matchAll(
      /(?:\bfrom|\bimport\(|\brequire\()\s*["']([^"'\s]+)["']/g,
    )) {
      const name = NAME.exec(specifier)?.[0];
      if (name && patterns.some((pattern) => pattern.test(name))) imported.add(name);
    }
  }
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const missing = [...imported].filter((name) => !declared.has(name) && !OPTIONAL.has(name)).sort();
  if (missing.length) {
    failed = true;
    console.error(
      `apps/${app}: bundle imports external package(s) not in dependencies: ${missing.join(', ')}`,
    );
  } else console.log(`apps/${app}: ${[...imported].sort().join(', ')} — all declared`);
}
process.exit(failed ? 1 : 0);
