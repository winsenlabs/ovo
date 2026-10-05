import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// OBS-4: on the live call path an error may be swallowed only where a `// swallow-ok: <why>`
// comment says why (same line, line above, or first line of the block). Everything else logs.
const ROOT = path.resolve(import.meta.dirname, '../..');
const LIVE_PATH = [
  'packages/plugin-media/src',
  'packages/plugin-carrier-twilio/src',
  'packages/plugin-kit/src/logger.ts',
  'apps/media-gateway/src',
  'apps/worker/src/media-runtime.ts',
  'apps/worker/src/inbound-runtime.ts',
  'apps/worker/src/worker-loop.ts',
  'apps/worker/src/terminal-session.ts',
  'apps/worker/src/worker-process.ts',
  'apps/worker/src/worker-media-server.ts',
  'apps/worker/src/pre-session-buffer.ts',
  'packages/plugin-voice/src/engine',
  'packages/plugin-stt-assemblyai/src',
];

const SILENT = [
  // Optional catch binding: the error cannot be logged because it was never named.
  /\bcatch\s*\{/,
  /\bcatch\s*\([^)]*\)\s*\{\s*\}/,
  /\.catch\(\s*\(\s*\)\s*=>\s*(?:undefined|null|\{\s*\}|\(\{\s*\}\))\s*\)/,
];

function files(entry: string): string[] {
  const full = path.join(ROOT, entry);
  if (!statSync(full).isDirectory()) return [entry];
  return readdirSync(full).flatMap((name) =>
    name.endsWith('.ts') || statSync(path.join(full, name)).isDirectory()
      ? files(path.join(entry, name))
      : [],
  );
}

function silentCatches(source: string): number[] {
  const lines = source.split('\n');
  return lines.flatMap((line, index) => {
    if (!SILENT.some((pattern) => pattern.test(line))) return [];
    const nearby = lines.slice(Math.max(0, index - 1), index + 2).join('\n');
    return nearby.includes('swallow-ok:') ? [] : [index + 1];
  });
}

describe('silent catch gate', () => {
  it('recognises each swallowing shape and honours the marker', () => {
    expect(silentCatches('try {\n  x();\n} catch {\n  return 1;\n}')).toEqual([3]);
    expect(silentCatches('} catch (error) {}')).toEqual([1]);
    expect(silentCatches('await p.catch(() => undefined);')).toEqual([1]);
    expect(silentCatches('await p.catch(() => ({}));')).toEqual([1]);
    expect(silentCatches('} catch {\n  // swallow-ok: optional body\n}')).toEqual([]);
    expect(silentCatches('} catch (error) {\n  log.warn("x", errorFields(error));\n}')).toEqual([]);
  });

  it('finds no unexplained swallowed error on the live call path', () => {
    const offenders = LIVE_PATH.flatMap(files).flatMap((file) =>
      silentCatches(readFileSync(path.join(ROOT, file), 'utf8')).map((line) => `${file}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
