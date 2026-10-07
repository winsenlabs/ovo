import type { FlowNode } from '@winsendotai/ovo-contracts';

/**
 * How many times a node is said again because the caller barged in before hearing its mandatory
 * lines. Each time is a caller turn, so a caller who keeps talking over the recording notice is
 * not held in it forever: after this the call moves on, and the transition names what went unheard.
 */
const UNHEARD_REPLAYS = 2;
const TOLD_LIMIT = 10;

/**
 * What one call's flow knows about its own speech: what the agent said last (P6, which a repeat
 * replays) and which of the current node's mandatory lines the caller has heard in full (P5).
 */
export class FlowPlayout {
  /** What the agent said in its most recent conversational turn, LLM replies included. */
  private spoken: { turn?: number; lines: string[] } = { lines: [] };
  /** The current node's mandatory lines the caller has not heard in full yet. */
  private unheard: string[] = [];
  private replays = 0;
  /** Mandatory lines the caller heard in full, as said, most recent last. */
  private readonly told: string[] = [];

  get lastSaid(): readonly string[] {
    return this.spoken.lines;
  }

  get unheardLines(): readonly string[] {
    return this.unheard;
  }

  get disclosed(): readonly string[] {
    return this.told;
  }

  said(turn: number, text: string): void {
    if (turn !== this.spoken.turn) this.spoken = { turn, lines: [] };
    this.spoken.lines.push(text);
  }

  /** A node was entered: its mandatory lines, less any this call could not render, wait. */
  entered(node: FlowNode, skippedLines: readonly string[]): void {
    this.unheard = (node.mandatory ?? []).filter((id) => !skippedLines.includes(id));
    this.replays = 0;
  }

  /** Returns true when this line was the last of the node's mandatory lines to be heard. */
  heard(lineId: string, text?: string): boolean {
    if (!this.unheard.includes(lineId)) return false;
    this.unheard = this.unheard.filter((id) => id !== lineId);
    if (text !== undefined && !this.told.includes(text)) {
      this.told.push(text);
      if (this.told.length > TOLD_LIMIT) this.told.shift();
    }
    return !this.unheard.length;
  }

  /** The node's lines from the first unheard mandatory one, while the replay budget lasts. */
  replay(node: FlowNode): string[] | undefined {
    if (!this.unheard.length || this.replays >= UNHEARD_REPLAYS) return undefined;
    return node.say.slice(Math.min(...this.unheard.map((id) => node.say.indexOf(id))));
  }

  replayed(): void {
    this.replays += 1;
  }

  /** The caller moved on without hearing them: the unheard ids, which are no longer waited for. */
  abandon(): string[] {
    const unheard = this.unheard;
    this.unheard = [];
    return unheard;
  }
}
