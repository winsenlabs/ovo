import type { CompatRule } from './types.ts';
import { pinFailures } from './types.ts';
export const pluginVersionNotInstalled: CompatRule = (input, stage) =>
  pinFailures(input, 'plugin_version_not_installed', stage);
