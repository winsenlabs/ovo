import type { RouteLines } from './ids.ts';
import { routingLines } from './issues.ts';
import { routingAgentRefs, type RoutingReleaseSnapshot } from './point.ts';
import type { HoldPolicy, TransferSource, TransferTarget } from './transfer.ts';
import { effectiveHold, TRANSFER_BUILT_IN_LINES, transferLabel } from './transfer-lines.ts';

/** The languages a release may speak a line in; `undefined` = any (a direct agent's is unknown here). */
type Spoken = Map<string, Set<string> | undefined>;

/**
 * Every fixed line a release may speak on this point, by release id, for prerender and for each
 * segment's approved speech-cache phrases:
 * - the router release (the point's house voice): its greeting, asks, re-asks, connecting, idle and
 *   end/callback lines, the queue announcement, and every hold and timeout line (built-in lines
 *   included where a default applies), in every language they are written in;
 * - each agent release a target is granted to: the target's announcement (else the point's, else
 *   the built-in one), the queue announcement for pool targets, the confirm question with `{label}`
 *   filled for `ask` targets, and the built-in `returned` line where a hold can return the caller.
 *   A pool member speaks only its own languages; a direct agent every language of the line.
 */
export function routingVoiceLines(snapshot: RoutingReleaseSnapshot): Map<string, string[]> {
  const lines = new Map<string, Set<string>>();
  const allowed = new Set(snapshot.language.allowed);
  const add = (releaseId: string, text: string | undefined) => {
    if (!text) return;
    const found = lines.get(releaseId) ?? new Set<string>();
    found.add(text);
    lines.set(releaseId, found);
  };
  const addLines = (releaseId: string, routeLines: RouteLines, languages?: ReadonlySet<string>) => {
    for (const [language, text] of Object.entries(routeLines))
      if (allowed.has(language) && (!languages || languages.has(language))) add(releaseId, text);
  };
  const router = snapshot.router.release.releaseId;
  const transfer = snapshot.transfer;
  for (const { lines: routeLines } of routingLines(snapshot)) addLines(router, routeLines);
  // Every hold this point can play, in the house voice; the default one too when any falls back.
  const holds: HoldPolicy[] = [effectiveHold(transfer)];
  for (const target of transfer?.targets ?? []) holds.push(effectiveHold(transfer, target.key));
  for (const hold of new Set(holds)) {
    for (const step of hold.steps) if (step.kind === 'line') addLines(router, step.line);
    for (const step of hold.onTimeout)
      if (step.kind === 'callback' || step.kind === 'end') addLines(router, step.line);
  }
  // A timeout chain that runs out ends the call with the built-in end line.
  addLines(router, TRANSFER_BUILT_IN_LINES.end);
  addLines(router, transfer?.queueAnnouncement ?? TRANSFER_BUILT_IN_LINES.queue);
  for (const target of transfer?.targets ?? []) {
    const queued = target.destination.kind === 'pool' || target.destination.kind === 'same-pool';
    const confirm = (target.confirm ?? transfer!.confirm) === 'ask';
    const returns = effectiveHold(transfer, target.key).onTimeout.some((s) => s.kind === 'return');
    for (const [releaseId, languages] of grantedReleases(snapshot, target)) {
      addLines(
        releaseId,
        target.announcement ?? transfer!.announcement ?? TRANSFER_BUILT_IN_LINES.announcement,
        languages,
      );
      if (queued)
        addLines(
          releaseId,
          transfer!.queueAnnouncement ?? TRANSFER_BUILT_IN_LINES.queue,
          languages,
        );
      if (returns) addLines(releaseId, TRANSFER_BUILT_IN_LINES.returned, languages);
      if (confirm)
        for (const [language, question] of Object.entries(TRANSFER_BUILT_IN_LINES.confirm))
          if (allowed.has(language) && (!languages || languages.has(language)))
            add(releaseId, question.replace('{label}', transferLabel(target, language)));
    }
  }
  return new Map([...lines].map(([releaseId, texts]) => [releaseId, [...texts]]));
}

/** The agent releases that may use a target (its `from`, else every agent the point reaches). */
function grantedReleases(snapshot: RoutingReleaseSnapshot, target: TransferTarget): Spoken {
  const spoken: Spoken = new Map();
  const grant = (releaseId: string, languages?: readonly string[]) => {
    if (releaseId === snapshot.router.release.releaseId) return;
    const known = spoken.get(releaseId);
    if (spoken.has(releaseId) && !known) return;
    if (!languages) spoken.set(releaseId, undefined);
    else spoken.set(releaseId, new Set([...(known ?? []), ...languages]));
  };
  const matches = (source: TransferSource | undefined, poolId?: string, memberId?: string) =>
    !source ||
    (source.kind === 'pool' && source.poolId === poolId) ||
    (source.kind === 'member' && source.poolId === poolId && source.memberId === memberId);
  const sources = target.from ?? [undefined];
  for (const pool of Object.values(snapshot.pools))
    for (const member of pool.members)
      if (
        sources.some(
          (source) =>
            matches(source, pool.id, member.id) ||
            (source?.kind === 'agent' && source.agentId === member.agent.agentId),
        )
      )
        grant(member.agent.release.releaseId, member.languages);
  // Agents a call reaches without a pool: the default target, direct and callback agents.
  for (const { ref } of routingAgentRefs(snapshot))
    if (
      ref.release.kind === 'pinned' &&
      sources.some(
        (source) => !source || (source.kind === 'agent' && source.agentId === ref.agentId),
      )
    )
      grant(ref.release.releaseId);
  return spoken;
}
