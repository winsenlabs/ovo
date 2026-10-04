// vitest globalSetup: a temporary violation log for the run; in teardown, violations are deduped by
// (pluginId, kind, key) and any entry missing from scripts/baselines/runtime-violations.json and from
// every scripts/baselines/pending/*.json `runtimeViolations` list fails the run (§3.7, §13.8).
// OVO_WRITE_VIOLATION_BASELINE=1 merges the run's violations into the baseline instead.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

interface Entry {
  pluginId: string;
  kind: string;
  key: string;
}

const id = (e: Entry) => `${e.pluginId}\u0000${e.kind}\u0000${e.key}`;

function allowedEntries(baselineDir: string): {
  top: Entry[];
  allowed: Set<string>;
  problems: string[];
} {
  const file = path.join(baselineDir, 'runtime-violations.json');
  const top: Entry[] = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')).violations ?? [])
    : [];
  const allowed = new Set(top.map(id));
  const problems: string[] = [];
  const pending = path.join(baselineDir, 'pending');
  if (existsSync(pending))
    for (const name of readdirSync(pending).filter((n) => n.endsWith('.json'))) {
      const entries =
        JSON.parse(readFileSync(path.join(pending, name), 'utf8')).runtimeViolations ?? [];
      for (const entry of entries as (Entry & { reason?: string; removeBy?: string })[]) {
        if (!entry.reason || entry.removeBy !== 'I1')
          problems.push(
            `pending/${name}: runtimeViolations entry needs a reason and removeBy "I1"`,
          );
        else allowed.add(id(entry));
      }
    }
  return { top, allowed, problems };
}

export function readViolationLog(file: string): Entry[] {
  const seen = new Map<string, Entry>();
  if (!existsSync(file)) return [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { pluginId, kind, key } = JSON.parse(line) as Entry;
    seen.set(id({ pluginId, kind, key }), { pluginId, kind, key });
  }
  return [...seen.values()];
}

/** Failures for violations absent from the top-level baseline and from every pending list. */
export function checkViolations(found: readonly Entry[], baselineDir: string): string[] {
  const { allowed, problems } = allowedEntries(baselineDir);
  return [
    ...problems,
    ...found
      .filter((entry) => !allowed.has(id(entry)))
      .map((e) => `new runtime violation ${e.kind} by ${e.pluginId} on ${e.key}`),
  ];
}

/** Merges `found` into the top-level baseline (OVO_WRITE_VIOLATION_BASELINE=1). */
export function writeViolationBaseline(found: readonly Entry[], baselineDir: string): number {
  const { top } = allowedEntries(baselineDir);
  const merged = new Map([...top, ...found].map((entry) => [id(entry), entry]));
  const violations = [...merged.values()].sort((a, b) =>
    id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0,
  );
  writeFileSync(
    path.join(baselineDir, 'runtime-violations.json'),
    `${JSON.stringify({ violations }, null, 2)}\n`,
  );
  return violations.length;
}

export default function setup(project: TestProject): () => void {
  const baselineDir = process.env.OVO_BASELINE_DIR ?? path.resolve('scripts/baselines');
  const dir = mkdtempSync(path.join(tmpdir(), 'ovo-violations-'));
  const log = path.join(dir, 'violations.jsonl');
  writeFileSync(log, '');
  process.env.OVO_PLUGIN_VIOLATION_LOG = log;
  project.provide('ovoViolationLog', log);
  return () => {
    const found = readViolationLog(log);
    rmSync(dir, { recursive: true, force: true });
    if (process.env.OVO_WRITE_VIOLATION_BASELINE === '1') {
      const count = writeViolationBaseline(found, baselineDir);
      console.log(`[runtime-violations] baseline now holds ${count} entries`);
      return;
    }
    const failures = checkViolations(found, baselineDir);
    if (failures.length) {
      process.exitCode = 1;
      throw new Error(
        `Runtime plugin violations outside scripts/baselines/runtime-violations.json and pending/*.json:\n${failures.join('\n')}`,
      );
    }
  };
}
