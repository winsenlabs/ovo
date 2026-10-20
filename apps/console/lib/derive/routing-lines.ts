import { routingLines, transferLines, type RoutingPointDraft } from '@winsendotai/ovo-contracts';

export interface LineRow {
  path: (string | number)[];
  label: string;
  languages: string[];
  /** The default language has no text: the router cannot speak this line to most callers. */
  missingDefault: boolean;
  /** Languages written here that the point does not allow. */
  unallowed: string[];
}

/** A human name for where a line is spoken, from its path in the draft. */
export function lineLabel(path: readonly (string | number)[], draft: RoutingPointDraft): string {
  const [head, a, b, c] = path;
  if (head === 'greeting') return 'Greeting';
  if (head === 'connecting') return 'Connecting';
  if (head === 'idle') return `Idle prompt ${Number(c ?? 0) + 1}`;
  if (head === 'nodes' && typeof a === 'number') {
    const node = draft.nodes[a];
    const id = node?.id ?? `#${a}`;
    if (b === 'ask') return `Question on ${id}`;
    if (b === 'fallback') return `Re-ask on ${id}`;
    if (b === 'branches' && typeof c === 'number')
      return `${node?.branches[c]?.key ?? c} on ${id}: closing line`;
  }
  if (head === 'transfer') {
    if (a === 'announcement') return 'Transfer announcement';
    if (a === 'queueAnnouncement') return 'Busy announcement';
    if (a === 'hold') return `Point hold: ${path.slice(2).join(' ')}`;
    if (a === 'targets' && typeof b === 'number') {
      const key = draft.transfer?.targets[b]?.key ?? `#${b}`;
      return `Transfer target ${key}: ${typeof c === 'string' ? c : 'hold'}`;
    }
  }
  return path.join(' > ');
}

/** Every line the point speaks (router and transfers) with which languages it covers. */
export function lineRows(draft: RoutingPointDraft): LineRow[] {
  const allowed = new Set(draft.language.allowed);
  return [...routingLines(draft), ...transferLines(draft.transfer)].map(({ path, lines }) => {
    const languages = Object.keys(lines);
    return {
      path: [...path],
      label: lineLabel(path, draft),
      languages,
      missingDefault: !languages.includes(draft.language.default),
      unallowed: languages.filter((l) => !allowed.has(l)),
    };
  });
}
