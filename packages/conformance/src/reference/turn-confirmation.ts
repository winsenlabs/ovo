import { classifyConfirmation } from '@winsendotai/ovo-contracts';

/** One user turn being aggregated: finals keyed by segment id, plus the live interim. */
export interface Turn {
  id: string;
  finals: Map<string, string>;
  interim: string;
}

/** The turn's text so far; interims count only while no final has landed. */
export function turnText(turn: Turn, withInterim = true): string {
  const parts = [...turn.finals.values()];
  if (withInterim && turn.interim) parts.push(turn.interim);
  return parts.filter(Boolean).join(' ').trim();
}

/**
 * Speech heard while a confirmation prompt is playing (§2.7). It is buffered, never discarded:
 * at `bot.stopped` a yes/no becomes a turn and anything else becomes `turn.reset{reason:'muted'}`.
 */
export class PromptBuffer {
  private lines: string[] = [];

  reset(): void {
    this.lines = [];
  }

  push(text: string): void {
    if (text.trim()) this.lines.push(text.trim());
  }

  /** The buffered answer, or undefined when the caller said nothing during the prompt. */
  take(): { text: string; answered: boolean } | undefined {
    if (!this.lines.length) return undefined;
    const text = this.lines.join(' ');
    this.lines = [];
    return { text, answered: classifyConfirmation(text) !== 'unclear' };
  }
}
