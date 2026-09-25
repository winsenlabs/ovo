import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, copyFile } from 'node:fs/promises';
// Bundle actual TS implementations, including workspace packages. Native/external SDK assets stay
// in the pinned node_modules tree. The runtime is not a reimplementation of the source bundle.
const entries = ['apps/api/src/index.ts'].filter(existsSync);
for (const entry of entries)
  await build({
    entryPoints: [entry],
    outfile: entry.replace(/src\/(index|main)\.ts$/, 'dist/index.js'),
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    loader: { '.sql': 'text' },
    sourcemap: true,
    external: ['fastify', 'pg-native', 'next', '@livekit/*'],
    banner: {
      js: "import { createRequire as __ovoCreateRequire } from 'node:module'; const require = __ovoCreateRequire(import.meta.url);",
    },
  });
for (const name of ['worker', 'dispatcher'])
  execFileSync('pnpm', ['--filter', `@winsendotai/ovo-${name}`, 'build'], { stdio: 'inherit' });
await mkdir('dist/notices', { recursive: true });
for (const [source, name] of [
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['packages/runtime/src/upstream/LICENSE', 'DEEPSEEK-LICENSE'],
  ['vendor/cordis/LICENSE', 'CORDIS-LICENSE'],
  ['vendor/cosmokit/LICENSE', 'COSMOKIT-LICENSE'],
])
  await copyFile(source, `dist/notices/${name}`);
console.log(`Built ${entries.length + 2} runnable application bundles with upstream notices.`);
