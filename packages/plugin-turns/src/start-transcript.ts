import { countWords } from '@winsendotai/ovo-contracts';

export function transcriptStartsTurn(text: string, language: string): boolean {
  return countWords(text, language) >= 1;
}
