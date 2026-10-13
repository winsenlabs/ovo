import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { CARTESIA_HOST, type CartesiaTtsBinding } from './binding.ts';
import {
  CARTESIA_TTS_BINDING_SCHEMA,
  CARTESIA_TTS_CONFIG_SCHEMA,
  CARTESIA_TTS_UI_FIELDS,
} from './schema.ts';
import { fixtures, fixtureTemplates } from './testing.ts';
import { CARTESIA_TTS_CAPABILITIES, CartesiaTts } from './tts.ts';

export {
  CARTESIA_HOST,
  CARTESIA_VERSION,
  DEFAULT_MODEL,
  SONIC_LANGUAGES,
  SONIC_MODELS,
  cacheRevision,
  outputFormat,
  requestFields,
  socketUrl,
  sonicLanguage,
  type CartesiaTtsBinding,
  type SonicModel,
} from './binding.ts';
export { CARTESIA_TTS_BINDING_SCHEMA } from './schema.ts';
export { CARTESIA_TTS_CAPABILITIES, CartesiaTts } from './tts.ts';
export { CartesiaTtsError } from './errors.ts';
export { CONTEXT_QUIET_MS } from './reply.ts';
export { ContextSlots, RETRY_PAUSES_MS } from './slots.ts';
export { fixtures, fixtureTemplates };

/** The price-card key the cost runtime derives for this plugin's meter. */
export const CARTESIA_TTS_METER_KEY = 'cartesia.streaming-tts.characters';

/** The secret path: a row holding a nested credential reference resolves that one. */
function keyPath(ref: unknown): string {
  return ref && typeof ref === 'object' && 'credentialRef' in ref ? '/credentialRef' : '';
}

export const cartesiaTtsPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-tts-cartesia',
    version: '0.1.0',
    contractVersion: 2,
    kind: 'tts',
    provider: 'cartesia',
    scope: 'session',
    requires: [],
    provides: [`${Cap.tts}@2`],
    bindingSchema: CARTESIA_TTS_BINDING_SCHEMA,
    configSchema: CARTESIA_TTS_CONFIG_SCHEMA,
    secretFields: [''],
    capabilities: CARTESIA_TTS_CAPABILITIES,
    meters: [
      {
        key: CARTESIA_TTS_METER_KEY,
        unit: 'characters',
        label: 'Cartesia Sonic characters',
        role: 'tts',
      },
    ],
    runtime: { egressHosts: [CARTESIA_HOST], modelLicences: [] },
    conformance: ['tts@1'],
    ui: {
      label: 'Cartesia Sonic 3.6 Text to Speech',
      description: 'Streaming μ-law speech; one context per utterance on one socket per call.',
      vendor: 'Cartesia',
      docsUrl: 'https://docs.cartesia.ai/api-reference/tts/websocket',
      slot: 'tts',
      fields: CARTESIA_TTS_UI_FIELDS,
    },
  },
  async (ctx, row) => {
    const tts = new CartesiaTts(
      ctx.net,
      await ctx.secret(keyPath(row.credentialRef)),
      (row.binding ?? {}) as CartesiaTtsBinding,
    );
    ctx.provide(Cap.tts, tts);
    ctx.effect(() => () => tts.dispose());
  },
);

export const plugins = [cartesiaTtsPlugin];
