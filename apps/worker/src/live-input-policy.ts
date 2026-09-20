import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

/** Keep provider admission, engine input, and STT cost coverage aligned. */
export function liveSessionRequiresInput(
  config: Pick<ReleaseRecord['config'], 'mode' | 'script'>,
): boolean {
  return config.mode !== 'announcement' || Boolean(config.script);
}
