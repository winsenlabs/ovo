import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// OBS-4: on the live call path an error may be swallowed only where a `// swallow-ok: <why>`
// comment says why (same line, line above, or first line of the block). Everything else logs.
const ROOT = path.resolve(import.meta.dirname, '../..');
const LIVE_PATH = [
  'packages/plugin-media/src',
  'packages/plugin-carrier-twilio/src',
  'packages/plugin-kit/src',
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
  'apps/worker/src/provider-prewarm.ts',
  'apps/dispatcher/src',
];

// Swallows found in code this gate's owner may not edit, awaiting a cross-lane fix. Listed by exact
// source text, so the fix (or any edit to the line) has to remove the entry. Empty since Wave 2.
const PENDING = new Set<string>([]);

const SILENT = [
  // Optional catch binding: the error cannot be logged because it was never named.
  /\bcatch\s*\{/,
  /\bcatch\s*\([^)]*\)\s*\{\s*\}/,
  // A rejection handler that takes no parameter (or an `_`-named one) cannot report the error,
  // whatever it returns: `.catch(() => undefined)`, `.catch(() => false)`, `.catch(_e => [])`.
  /\.catch\(\s*(?:async\s*)?(?:\(\s*\)|\(?\s*_\w*\s*\)?)\s*=>/,
  /\.catch\(\s*(?:noop|ignore)\s*\)/,
];

/** `catch (error) { … }` whose block never mentions `error`: named, then dropped. */
function unusedCatchBindings(lines: string[]): number[] {
  const offenders: number[] = [];
  lines.forEach((line, index) => {
    const match = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{/.exec(line);
    if (!match) return;
    const name = match[1]!;
    let depth = 0;
    let body = '';
    for (let at = index; at < lines.length; at += 1) {
      const text = at === index ? line.slice(match.index + match[0].length - 1) : lines[at]!;
      for (const char of text) {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        body += char;
        if (depth === 0) break;
      }
      if (depth === 0) break;
      body += '\n';
    }
    const code = body.replace(/\/\/.*$/gm, '');
    if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(code.slice(1)))
      offenders.push(index);
  });
  return offenders;
}
function files(entry: string): string[] {
  const full = path.join(ROOT, entry);
  if (!statSync(full).isDirectory()) return [entry];
  return readdirSync(full).flatMap((name) =>
    (name.endsWith('.ts') && !name.endsWith('.test.ts')) ||
    statSync(path.join(full, name)).isDirectory()
      ? files(path.join(entry, name))
      : [],
  );
}

function silentCatches(source: string): number[] {
  const lines = source.split('\n');
  const flagged = new Set([
    ...lines.flatMap((line, index) =>
      SILENT.some((pattern) => pattern.test(line)) ? [index] : [],
    ),
    ...unusedCatchBindings(lines),
  ]);
  return [...flagged]
    .sort((a, b) => a - b)
    .flatMap((index) => {
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

  it('also catches rejection handlers that drop their error, whatever they return', () => {
    expect(silentCatches('const ok = await p.catch(() => false);')).toEqual([1]);
    expect(silentCatches('await p.catch(async () => []);')).toEqual([1]);
    expect(silentCatches('await p.catch((_error) => null);')).toEqual([1]);
    expect(silentCatches('await p.catch(_e => 0);')).toEqual([1]);
    expect(silentCatches('await p.catch(noop);')).toEqual([1]);
    expect(silentCatches('await p.catch((error) => log.warn("x", { error }));')).toEqual([]);
  });

  it('flags a named catch binding the block never uses, and accepts one it does use', () => {
    expect(silentCatches('try {\n  x();\n} catch (error) {\n  return fallback;\n}')).toEqual([3]);
    expect(silentCatches('} catch (error) {\n  // error is fine\n  retry();\n}')).toEqual([1]);
    expect(silentCatches('} catch (error) {\n  if (x) {\n    throw error;\n  }\n}')).toEqual([]);
    expect(silentCatches('} catch (cause) {\n  // swallow-ok: probe\n  return 1;\n}')).toEqual([]);
  });

  it('finds no unexplained swallowed error on the live call path', () => {
    const offenders = LIVE_PATH.flatMap(files).flatMap((file) => {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      const lines = source.split('\n');
      return silentCatches(source).map((line) => `${file}: ${lines[line - 1]!.trim()}`);
    });
    expect(offenders.filter((offender) => !PENDING.has(offender))).toEqual([]);
    // A fixed or moved site must leave PENDING too, so the list cannot hide a new swallow.
    expect([...PENDING].filter((entry) => !offenders.includes(entry))).toEqual([]);
  });
});
