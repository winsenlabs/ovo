// Picking a named latency stage out of a `/performance` grouping, without hardcoding which
// provider's stage name means "first audio" (brief §3 Home: "take the max-sample stage group if
// the name differs, and never hardcode").
import type { PerformanceGroupResult } from '@winsendotai/ovo-contracts';

const FIRST_AUDIO_PATTERN = /first[\s_-]?(audio|sentence|response)|ttfa|time[\s_-]?to[\s_-]?first/i;

/** The group whose `cohort.stage` reads as a first-audio/first-sentence latency stage. Falls
 * back to the group with the most samples when no name matches, so the KPI still has a value
 * instead of silently going "Unknown" just because an installation renamed its stages. */
export function pickFirstAudioStage(
  groups: readonly PerformanceGroupResult[],
): PerformanceGroupResult | null {
  if (!groups.length) return null;
  const named = groups.find((group) => FIRST_AUDIO_PATTERN.test(group.cohort.stage ?? ''));
  if (named) return named;
  return groups.reduce((best, group) => (group.sampleCount > best.sampleCount ? group : best));
}
