import { isDeepStrictEqual } from 'node:util';
import type {
  FixtureTemplate,
  FixtureTemplateInput,
  NetFixtureScript,
} from '@winsendotai/ovo-contracts';

export interface SttReplayPlan {
  scripts: NetFixtureScript[];
  messageTurns: (number | undefined)[][];
  shutdownStarts: (number | undefined)[];
}

/** Infer turn boundaries from template structure, never from provider-specific wire payloads. */
export function planSttReplay(
  template: FixtureTemplate,
  input: FixtureTemplateInput,
): SttReplayPlan {
  const render = (through: number) =>
    template({
      ...input,
      // Preserve silence/timing metadata in the suffix while withholding later utterances.
      turns: input.turns.map((turn, index) =>
        index <= through ? turn : { ...turn, say: undefined },
      ),
    });
  let scripts = render(-1);
  let tags: (number | undefined)[][] = scripts.map((script) => script.steps.map(() => undefined));
  for (const [turnIndex, turn] of input.turns.entries()) {
    if (!turn.say) continue;
    const next = render(turnIndex);
    if (next.length !== scripts.length) throw unavailable();
    let additions = 0;
    tags = next.map((script, scriptIndex) => {
      const previous = scripts[scriptIndex]!;
      if (!isDeepStrictEqual({ ...script, steps: [] }, { ...previous, steps: [] }))
        throw unavailable();
      const before = previous.steps;
      const after = script.steps;
      let prefix = 0;
      while (
        prefix < before.length &&
        prefix < after.length &&
        isDeepStrictEqual(before[prefix], after[prefix])
      )
        prefix++;
      let suffix = 0;
      while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        isDeepStrictEqual(before[before.length - suffix - 1], after[after.length - suffix - 1])
      )
        suffix++;
      if (prefix + suffix !== before.length) throw unavailable();
      const inserted = after.slice(prefix, after.length - suffix);
      if (inserted.some((step) => !('send' in step) && !('delayMs' in step))) throw unavailable();
      additions += inserted.filter((step) => 'send' in step).length;
      const previousTags = tags[scriptIndex]!;
      return [
        ...previousTags.slice(0, prefix),
        ...inserted.map(() => turnIndex),
        ...previousTags.slice(before.length - suffix),
      ];
    });
    if (!additions) throw unavailable();
    scripts = next;
  }
  for (const script of scripts) {
    if (
      script.steps.filter((step) => 'expect' in step && step.expect === 'ws-open').length !== 1 ||
      script.steps.some((step) => 'expect' in step && step.expect === 'http')
    )
      throw unavailable();
  }
  return {
    scripts,
    shutdownStarts: scripts.map((script, index) => {
      if (scripts.length !== 1) return undefined;
      const lastTurn = tags[index]!.findLastIndex((turn) => turn !== undefined);
      const start = lastTurn + 1;
      const tail = script.steps.slice(start);
      const final = tail.at(-1);
      if (
        tail[0] &&
        'expect' in tail[0] &&
        tail[0].expect === 'ws-send' &&
        !tail[0].repeat &&
        final &&
        'close' in final &&
        final.close.code === 1000 &&
        tail.slice(1, -1).every((step) => 'send' in step || 'delayMs' in step)
      )
        return start;
      return undefined;
    }),
    messageTurns: scripts.map((script, index) =>
      script.steps.flatMap((step, at) => ('send' in step ? [tags[index]![at]] : [])),
    ),
  };
}

function unavailable(): Error {
  return new Error(
    'fixture_unavailable: STT template cannot isolate caller-turn replay without a fixture gate contract',
  );
}
