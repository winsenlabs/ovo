import type { AgentConfig } from '@winsendotai/ovo-contracts';

/** Keep provider admission, engine input, and STT cost coverage aligned. */
export function sessionRequiresInput(config: Pick<AgentConfig, 'mode' | 'script'>): boolean {
  return config.mode !== 'announcement' || Boolean(config.script);
}

// N4: which caller words the turn detector may act on, from the agent's languages.
export { turnDetectorConfig } from './turn-detector-languages.ts';
