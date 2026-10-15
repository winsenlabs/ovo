import { semicolonsAsSentences } from '@winsendotai/ovo-contracts';

/**
 * `semicolonsAsSentences` over a streamed reply's deltas (Wave 12, call 8cb76efc F5), before the
 * segmenter: a semicolon and the spaces after it are held until the next letter shows whether it
 * ends a sentence, so the segmenter cuts there and the reply cap counts the sentence.
 */
export class SpokenSentences {
  private held = '';

  push(delta: string): string {
    const text = this.held + delta;
    const tail = /;\s*$/u.exec(text);
    const cut = tail ? tail.index : text.length;
    this.held = text.slice(cut);
    return semicolonsAsSentences(text.slice(0, cut));
  }

  finish(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}
