import type { AgentConfig } from '@winsendotai/ovo-contracts';

/** Keep provider admission, engine input, and STT cost coverage aligned. */
export function sessionRequiresInput(config: Pick<AgentConfig, 'mode' | 'script'>): boolean {
  return config.mode !== 'announcement' || Boolean(config.script);
}
