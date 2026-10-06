import type { SpeechKind } from '@winsendotai/ovo-contracts';
import type { ApprovedSpeechPhrase } from './types.ts';

export class ApprovedSpeechPolicy {
  private readonly acknowledgments = new Set<string>();
  private readonly announcements = new Set<string>();
  private readonly scripted = new Set<string>();

  constructor(
    phrases: readonly ApprovedSpeechPhrase[],
    private readonly announcementMode: boolean,
  ) {
    for (const phrase of phrases) {
      if (!phrase.text || !phrase.text.trim())
        throw new TypeError('Approved phrase text must not be empty');
      if (phrase.purpose === 'announcement') this.announcements.add(phrase.text);
      else if (phrase.purpose === 'scripted') this.scripted.add(phrase.text);
      else this.acknowledgments.add(phrase.text);
    }
  }

  /** True when this exact text is one of the release's fixed lines, whatever its speech kind. */
  isScripted(text: string): boolean {
    return this.scripted.has(text);
  }

  permits(text: string, kind: SpeechKind): boolean {
    if (this.scripted.has(text)) return true;
    if (kind === 'acknowledgment' || kind === 'progress') return this.acknowledgments.has(text);
    return this.announcementMode && this.announcements.has(text);
  }
}
