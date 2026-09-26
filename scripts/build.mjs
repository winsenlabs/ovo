import { execFileSync } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
// App scripts are also the real Docker bundlers; native externals have one source of truth.
for (const name of ['api', 'worker', 'dispatcher'])
  execFileSync('pnpm', ['--filter', `@winsendotai/ovo-${name}`, 'build'], { stdio: 'inherit' });
await mkdir('dist/notices', { recursive: true });
for (const [source, name] of [
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['packages/runtime/src/upstream/LICENSE', 'DEEPSEEK-LICENSE'],
  ['vendor/cordis/LICENSE', 'CORDIS-LICENSE'],
  ['vendor/cosmokit/LICENSE', 'COSMOKIT-LICENSE'],
])
  await copyFile(source, `dist/notices/${name}`);
console.log(`Built 3 runnable application bundles with upstream notices.`);
