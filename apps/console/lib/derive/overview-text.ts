// Pure text helpers for the agent Overview tab. Split out of `features/agent-overview.tsx` to
// stay under the module-size gate.

/** `formatDuration` (the shared helper every other screen uses) floors anything over a second to
 * whole seconds, so a first-audio p95 of 1.4s reads as a misleadingly rounder "1s" — on a latency
 * KPI specifically, that swallows real signal. One decimal below ten seconds; whole seconds past
 * that, matching the shared helper's own cutoff for everything larger. */
export function formatP95Duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/** Best-effort slot extraction from a free-text readiness blocker, so the Overview tab can link
 * straight to the section that fixes it (brief §3 Overview: "each blocker links to its section").
 * Unmatched text still renders — it simply stays plain text instead of a link. */
export function blockerSlot(message: string): string | undefined {
  const forSlot = /\bslot\s+([a-zA-Z]+)\b/.exec(message);
  if (forSlot) return forSlot[1];
  const pluginFor = /^([a-zA-Z]+) plugin\b/.exec(message);
  if (pluginFor) return pluginFor[1];
  return undefined;
}
