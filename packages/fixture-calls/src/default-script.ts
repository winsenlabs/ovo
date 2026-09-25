import type { AgentConfig } from '@winsendotai/ovo-contracts';
import type { CallerScript } from './types.ts';

export function defaultCallerScript(config: AgentConfig): CallerScript {
  if (config.mode === 'announcement') return { turns: [] };
  if (config.mode === 'faq') {
    const [first, second] = config.faq;
    return {
      turns: [
        { atMs: 0, say: first?.question ?? 'What can you help me with?' },
        { atMs: 1200, say: second?.question ?? 'Can you say that again?' },
      ],
    };
  }
  if (config.mode === 'agent')
    return {
      turns: [
        { atMs: 0, say: 'Please do that.' },
        { atMs: 1200, say: 'yes' },
      ],
    };
  return { turns: [{ atMs: 0, say: 'Can you help me?' }] };
}

export function predictedAgentTexts(config: AgentConfig): string[] {
  const texts =
    config.mode === 'announcement'
      ? [config.message]
      : config.mode === 'faq'
        ? [config.faq[0]?.answer, config.faq[1]?.answer ?? config.clarification]
        : config.mode === 'context'
          ? ['All done.']
          : [config.processing.initial, 'All done.'];
  return [...new Set(texts.filter(Boolean))];
}
