import type { TranscriptRevision } from './provider-types.ts';

export interface TurnPolicyConfig {
  backchannels?: readonly string[];
  minBargeInCharacters?: number;
}

export class TranscriptTurnPolicy {
  private readonly backchannels: Set<string>;
  private readonly minBargeInCharacters: number;
  private acceptedRevision = 0;
  private acceptedText = '';

  constructor(config: TurnPolicyConfig = {}) {
    this.backchannels = new Set(
      (config.backchannels ?? ['yes', 'yeah', 'okay', 'ok', 'uh huh', 'mm hmm']).map(normalize),
    );
    this.minBargeInCharacters = config.minBargeInCharacters ?? 3;
  }

  observe(revision: TranscriptRevision): {
    interrupt: boolean;
    accepted?: string;
    ignored: boolean;
  } {
    if (revision.revision <= this.acceptedRevision) return { interrupt: false, ignored: true };
    const normalized = normalize(revision.text);
    const backchannel = this.backchannels.has(normalized);
    const interrupt =
      Boolean(revision.speechStarted) &&
      !backchannel &&
      normalized.length >= this.minBargeInCharacters;
    if (!revision.isFinal || !revision.speechFinal || !normalized || backchannel)
      return { interrupt, ignored: false };
    if (revision.revision <= this.acceptedRevision || normalized === this.acceptedText)
      return { interrupt, ignored: true };
    this.acceptedRevision = revision.revision;
    this.acceptedText = normalized;
    return { interrupt, accepted: revision.text.trim(), ignored: false };
  }
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
