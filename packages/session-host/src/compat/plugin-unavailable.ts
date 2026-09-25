import type { CompatRule } from './types.ts';
import { pinFailures } from './types.ts';
export const pluginUnavailable: CompatRule = (input, stage) =>
  pinFailures(input, 'plugin_unavailable', stage);
