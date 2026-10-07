import { Cap, type AudioFilter } from '@winsendotai/ovo-contracts';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
import { AudioFilterConfigSchema } from './config.ts';
import { TelephonyAudioFilter } from './telephony-filter.ts';

export {
  AudioFilterConfigSchema,
  PHONE_AUDIO_FILTER_CONFIG,
  type AudioFilterConfig,
} from './config.ts';
export { TelephonyAudioFilter } from './telephony-filter.ts';

export const AUDIO_FILTER_PLUGIN_ID = '@winsendotai/ovo-audio-filter-telephony';

/** Pure JS, no native or WASM code: rumble, hum and (opt-in) steady-noise removal for phone audio. */
export const telephonyAudioFilterPlugin = definePluginV2(
  {
    id: AUDIO_FILTER_PLUGIN_ID,
    version: '0.1.0',
    scope: 'session',
    kind: 'audio-filter',
    provider: 'ovo',
    provides: [Cap.audioFilter],
    config: AudioFilterConfigSchema,
  },
  (ctx, config) => {
    ctx.provide(Cap.audioFilter, new TelephonyAudioFilter(config) as AudioFilter);
  },
);

export const plugins = [telephonyAudioFilterPlugin];
export const fixtures = {};
export const fixtureTemplates = {};
