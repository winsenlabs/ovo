export * from './budgets.ts';
export * from './history.ts';
export * from './media-output.ts';
export * from './plugins.ts';
export * from './provider-types.ts';
export * from './production-plugins.ts';
export * from './engine-v2-adapter.ts';
export * from './scheduler.ts';
export * from './session-engine.ts';
export * from './simulated-output.ts';
export * from './turn-policy.ts';
export * from './types.ts';

import { createSpeechSchedulerPlugin } from './plugins.ts';
import { createNativeVoiceEngineV2Plugin } from './engine-v2-adapter.ts';
import { createStreamingMediaSpeechOutputPlugin } from './production-plugins.ts';

/** First-party inventory; E2 appends text-filter plugins here without changing distribution. */
export const plugins = [
  createSpeechSchedulerPlugin(),
  createNativeVoiceEngineV2Plugin(),
  createStreamingMediaSpeechOutputPlugin({ source: 'v2' }),
];
