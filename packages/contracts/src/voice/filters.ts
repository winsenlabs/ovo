import type { JsonSchema } from '../agent.ts';

export interface TextFilterContext {
  language: string;
  toolSchema?: JsonSchema;
}

/** Applied to agent text before TTS, lowest `order` first (capability `ovo.text-filter`, many). */
export interface TextFilter {
  id: string;
  order: number;
  apply(text: string, ctx: TextFilterContext): string;
}

export interface AudioFilter {
  start(rate: number): void;
  filter(pcm: Int16Array): Int16Array;
  stop(): void;
}
