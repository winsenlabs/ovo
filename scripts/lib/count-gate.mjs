// A per-file count ratchet shared by the provider-name and capability-key gates.
import { inScope, loadBaselines, writeJson } from './gate-support.mjs';

/**
 * `counts` maps file → occurrences. A file may not exceed its baselined count (top-level or any
 * pending entry); files absent from every baseline must be at zero. Decreases and stale entries warn.
 */
export async function ratchet(args, { fileName, key, counts, what }) {
  const baselines = await loadBaselines(args, fileName, key);
  const allowed = new Map(Object.entries(baselines.top?.files ?? {}));
  for (const entry of baselines.pending)
    allowed.set(entry.file, Math.max(entry.count, allowed.get(entry.file) ?? 0));
  const errors = [...baselines.errors];
  const warnings = [];
  for (const [file, count] of counts) {
    if (!count || !inScope(file, args.only)) continue;
    const limit = allowed.get(file) ?? 0;
    if (count > limit)
      errors.push(
        `${file}: ${count} ${what}${limit ? `, above the baselined ${limit}` : ''}; move them behind contracts or a plugin`,
      );
  }
  for (const [file, limit] of allowed) {
    if (!inScope(file, args.only)) continue;
    const current = counts.get(file) ?? 0;
    if (current === 0) warnings.push(`stale baseline entry ${file}`);
    else if (current < limit) warnings.push(`baseline entry ${file} can shrink to ${current}`);
  }
  if (args.writeBaseline) {
    const pending = new Set(baselines.pending.map((entry) => entry.file));
    const files = Object.fromEntries(
      [...counts].filter(([file, count]) => count > 0 && !pending.has(file)).sort(),
    );
    await writeJson(baselines.file, { files });
    console.log(`wrote ${Object.keys(files).length} entries to ${baselines.file}`);
    return { errors: baselines.errors, warnings };
  }
  return { errors, warnings };
}
