import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { withEgressSentinel } from '@winsendotai/ovo-conformance/drivers';

const root = fileURLToPath(new URL('../../../', import.meta.url));
it('the real worker build flags load the lazy ESM native runner in CommonJS and speak offline', async () => {
  await withEgressSentinel(
    async (sentinel) => {
      const folder = await mkdtemp(`${root}packages/plugin-engine-livekit/.bundle-`);
      try {
        const script = JSON.parse(await readFile(`${root}apps/worker/package.json`, 'utf8')).scripts
          .build as string;
        const entry = `${folder}/entry.ts`,
          output = `${folder}/smoke.cjs`;
        await writeFile(
          entry,
          `
import { plugins, ENGINE_ID } from '../src/index.ts';
import { Cap } from '@winsendotai/ovo-contracts';
import { createFakeCarrier, createScriptedTts, realClock, withEgressSentinel } from '../../conformance/src/drivers.ts';
(async () => {
 await withEgressSentinel(async (sentinel) => {
  const carrier = createFakeCarrier();
  const values = new Map();
  values.set(Cap.media, carrier.duplex); values.set(Cap.tts, createScriptedTts());
  values.set(Cap.clock, realClock); values.set(Cap.usage, () => {});
  values.set(Cap.behavior, { respond: async () => 'Native bundle speech.', isComplete: () => true });
  const ctx = { get: (key) => values.get(key), maybe: (key) => values.get(key), provide: (key,value) => values.set(key,value), effect: () => {} };
  await plugins.find(p => p.manifest.id === ENGINE_ID + '/speech').apply(ctx, {});
  await plugins.find(p => p.manifest.id === ENGINE_ID).apply(ctx, { engine: {}, session: { mode: 'announcement', language: 'en-US', inputEnabled: false, variables: {}, maxCallSeconds: 10, acknowledgements: [] } });
  const engine = values.get(Cap.engine); await engine.start();
  const outcome = await engine.ended;
  if (outcome.reason !== 'behavior_completed' || !carrier.log.some(e => e.type === 'audio') || sentinel.attempts.length) throw new Error('bundle did not complete offline audio');
  console.log('E3_BUNDLE_AUDIO_OK');
 }, { allowLoopback: false });
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
        );
        const flags = script
          .split(' ')
          .slice(2)
          .map((arg) => (arg.startsWith('--outfile=') ? `--outfile=${output}` : arg));
        execFileSync('pnpm', ['exec', 'esbuild', entry, ...flags], {
          cwd: root,
          stdio: 'pipe',
          timeout: 30000,
        });
        const result = execFileSync(process.execPath, [output], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30000,
        });
        expect(result).toContain('E3_BUNDLE_AUDIO_OK');
        expect(sentinel.attempts).toEqual([]);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    { allowLoopback: false },
  );
}, 60000);

it('the image and every engine-reaching app build use glibc and preserve native dependencies as externals', async () => {
  await withEgressSentinel(
    async () => {
      const docker = await readFile(`${root}infra/container/Dockerfile`, 'utf8');
      expect(docker).not.toContain('alpine');
      expect(docker.match(/FROM node:24\.8\.0-bookworm-slim/g)).toHaveLength(6);
      expect(docker).toContain('RUN pnpm --filter @winsendotai/ovo-api build');
      for (const app of ['worker', 'api', 'media-gateway', 'dispatcher']) {
        const script = JSON.parse(await readFile(`${root}apps/${app}/package.json`, 'utf8')).scripts
          .build;
        for (const external of ['@livekit/*', 'sharp', 'onnxruntime-node'])
          expect(script).toContain(`--external:${external}`);
      }
    },
    { allowLoopback: false },
  );
});
