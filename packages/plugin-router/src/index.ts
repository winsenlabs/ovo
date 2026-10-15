import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { createRouterBehaviorPlugin } from './plugin.ts';

export {
  createRouterBehaviorPlugin,
  parseRouterConfig,
  routerConfigSchema,
  ROUTER_BEHAVIOR_PLUGIN_ID,
  type RouterPluginConfig,
} from './plugin.ts';
export { RouterCore } from './core.ts';
export type { RouterPhase, RouterPorts, RouterReply } from './ports.ts';
export { RouterBehavior } from './behavior.ts';
export { RouteRecorder, type RecordedRouteEvent } from './events.ts';
export { isOpen, localTime } from './hours.ts';
export { normalizeText, scriptShare, words, LANGUAGE_SCRIPTS } from './text.ts';
export { BUILT_IN_LINES, pickLine } from './lines.ts';
export { eligibleTiers, pickMember, type MemberPick } from './members.ts';
export { routeVariables, type Resolution, type RouteOutcome } from './targets.ts';
export * from './engines/index.ts';

/** The distribution catalog's view of this package (milestone M1 registered it): the router behaviour. */
export const plugins: PluginDefinition[] = [createRouterBehaviorPlugin()];
