export * from './budgets.ts';
export * from './history.ts';
export * from './media-output.ts';
export * from './plugins.ts';
export * from './provider-types.ts';
export * from './production-plugins.ts';
export * from './engine/plugin.ts';
export * from './engine/session-engine.ts';
export * from './speech/media-output-v2.ts';
export * from './speech/plugin.ts';
export * from './speech/text-filters.ts';
export * from './scheduler.ts';
export * from './session-engine.ts';
export * from './simulated-output.ts';
export * from './types.ts';

import { createSpeechSchedulerPlugin } from './plugins.ts';
import { createNativeVoiceEngineV2Plugin } from './engine/plugin.ts';
import { createNativeStreamingMediaOutputPlugin } from './speech/plugin.ts';
import {
  createIndianVerbalisationTextFilterPlugin,
  createMarkdownTextFilterPlugin,
  createUrlTextFilterPlugin,
} from './speech/text-filters.ts';

/** First-party inventory; E2 appends text-filter plugins here without changing distribution. */
export const plugins = [
  createSpeechSchedulerPlugin(),
  createNativeVoiceEngineV2Plugin(),
  createNativeStreamingMediaOutputPlugin(),
  createMarkdownTextFilterPlugin(),
  createUrlTextFilterPlugin(),
  createIndianVerbalisationTextFilterPlugin(),
];
