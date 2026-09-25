import type { SpeechKind } from '@winsendotai/ovo-plugin-voice';
import type { ApprovedSpeechPhrase } from './types.ts';

export class ApprovedSpeechPolicy {
  private readonly acknowledgments = new Set<string>();
  private readonly announcements = new Set<string>();

  constructor(
    phrases: readonly ApprovedSpeechPhrase[],
    private readonly announcementMode: boolean,
  ) {
    for (const phrase of phrases) {
      if (!phrase.text || !phrase.text.trim())
        throw new TypeError('Approved phrase text must not be empty');
      if (phrase.purpose === 'announcement') this.announcements.add(phrase.text);
      else this.acknowledgments.add(phrase.text);
    }
  }

  permits(text: string, kind: SpeechKind): boolean {
    if (kind === 'acknowledgment' || kind === 'progress') return this.acknowledgments.has(text);
    return this.announcementMode && this.announcements.has(text);
  }
}
