import {
  normalizeForMatch,
  type Behavior,
  type FinalUtterance,
  type PartialUtterance,
  type TurnSpeculation,
} from '@winsendotai/ovo-contracts';

/**
 * Hands the caller's words to a behaviour that works ahead of them (LAT-4). A hook that throws is
 * reported and ignored: speculation never fails a turn.
 */
export class SpeculationHooks {
  constructor(
    private readonly behavior: Behavior & TurnSpeculation,
    private readonly failed: (hook: string, error: unknown) => void,
  ) {}

  prepare({ turnId, text, stable }: PartialUtterance): void {
    this.call('prepare', () => this.behavior.prepare?.({ turnId, text, stable }));
  }

  finalize(final: FinalUtterance): void {
    this.call('finalize', () => this.behavior.finalize?.(final));
  }

  discard(turnId: string, reason: 'reset' | 'superseded'): void {
    this.call('discard', () => this.behavior.discard?.(turnId, reason));
  }

  private call(hook: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.failed(hook, error);
    }
  }
}

/**
 * AGT-10: an utterance that was never answered, joined with the caller's next one. A later
 * utterance that already repeats the earlier words (an STT revision) replaces them, and one the
 * earlier words already end with adds nothing.
 */
export function mergeUtterances(earlier: string, later: string): string {
  const first = earlier.trim();
  const next = later.trim();
  if (!first || !next) return first || next;
  const a = normalizeForMatch(first);
  const b = normalizeForMatch(next);
  if (b === a || b.startsWith(a + ' ')) return next;
  if (a.endsWith(' ' + b)) return first;
  return `${first} ${next}`;
}
