import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { CARTESIA_AUTO_CAPABILITIES, CartesiaAutoStt } from './auto.ts';
import type { CartesiaAutoBinding, CartesiaManualBinding } from './binding.ts';
import { CARTESIA_MANUAL_CAPABILITIES, CartesiaManualStt } from './manual.ts';
import {
  CARTESIA_AUTO_BINDING_SCHEMA,
  CARTESIA_AUTO_UI_FIELDS,
  CARTESIA_MANUAL_BINDING_SCHEMA,
  CARTESIA_MANUAL_UI_FIELDS,
  CARTESIA_STT_CONFIG_SCHEMA,
} from './schema.ts';
import { AUTO_ID, MANUAL_ID, fixtureTemplates, fixtures } from './testing.ts';
import { CARTESIA_HOST } from './wire.ts';

export { CARTESIA_AUTO_CAPABILITIES, CartesiaAutoStt, AutoSession } from './auto.ts';
export { CARTESIA_MANUAL_CAPABILITIES, CartesiaManualStt, ManualSession } from './manual.ts';
export {
  ENDPOINTING,
  INK2_LANGUAGES,
  MAX_KEYTERMS,
  MAX_KEYTERM_CHARS,
  WHISPER_LANGUAGES,
  applyUpdate,
  autoUrl,
  callKeyterms,
  checkTurn,
  manualUrl,
  type CartesiaAutoBinding,
  type CartesiaManualBinding,
  type TurnSettings,
} from './binding.ts';
export { BacklogPacer, KEEPER_GAP_MS, KEEPER_TICK_MS, SilenceKeeper } from './pacing.ts';
export { CARTESIA_AUTO_BINDING_SCHEMA, CARTESIA_MANUAL_BINDING_SCHEMA } from './schema.ts';
export { FINISH_TIMEOUT_MS } from './session.ts';
export { CARTESIA_HOST, CARTESIA_VERSION, CartesiaSttError } from './wire.ts';
export { fixtures, fixtureTemplates };

/** The keys `meterKey()` derives for each definition's provider; the price card picks the model. */
export const CARTESIA_STT_METER_KEY = 'cartesia.streaming-stt.audio_seconds';
export const CARTESIA_MANUAL_STT_METER_KEY = 'cartesia-manual.streaming-stt.audio_seconds';

type Row = Record<string, unknown>;
const agentTerms = (row: Row) => ({ keyterms: row.keyterms as string[] | undefined });

export const cartesiaSttPlugin = definePlugin(
  {
    id: AUTO_ID,
    version: '0.1.0',
    contractVersion: 2,
    kind: 'stt',
    provider: 'cartesia',
    scope: 'session',
    requires: [],
    provides: [`${Cap.stt}@2`],
    bindingSchema: CARTESIA_AUTO_BINDING_SCHEMA,
    configSchema: CARTESIA_STT_CONFIG_SCHEMA,
    secretFields: [''],
    capabilities: CARTESIA_AUTO_CAPABILITIES,
    meters: [
      {
        key: CARTESIA_STT_METER_KEY,
        unit: 'audio_seconds',
        label: 'Cartesia Ink-2 turns audio seconds',
        role: 'stt',
      },
    ],
    runtime: { egressHosts: [CARTESIA_HOST], modelLicences: [] },
    conformance: ['stt@1'],
    ui: {
      label: 'Cartesia Ink-2 STT (provider turns)',
      description: 'Realtime transcription with Cartesia turn detection; no local VAD needed.',
      vendor: 'Cartesia',
      docsUrl: 'https://docs.cartesia.ai/api-reference/stt/turns/websocket',
      slot: 'stt',
      fields: CARTESIA_AUTO_UI_FIELDS,
    },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as CartesiaAutoBinding;
    ctx.provide(
      Cap.stt,
      new CartesiaAutoStt(ctx.net, await ctx.secret(''), binding, undefined, agentTerms(row)),
    );
  },
);

export const cartesiaManualSttPlugin = definePlugin(
  {
    id: MANUAL_ID,
    version: '0.1.0',
    contractVersion: 2,
    kind: 'stt',
    // Its own provider: the runtime installs one STT definition per provider, and bindings resolve
    // a plugin by (kind, provider). Same API key as `cartesia`, stored under this provider.
    provider: 'cartesia-manual',
    scope: 'session',
    requires: [],
    provides: [`${Cap.stt}@2`],
    bindingSchema: CARTESIA_MANUAL_BINDING_SCHEMA,
    configSchema: CARTESIA_STT_CONFIG_SCHEMA,
    secretFields: [''],
    capabilities: CARTESIA_MANUAL_CAPABILITIES,
    meters: [
      {
        key: CARTESIA_MANUAL_STT_METER_KEY,
        unit: 'audio_seconds',
        label: 'Cartesia Ink (finalize) audio seconds',
        role: 'stt',
      },
    ],
    runtime: { egressHosts: [CARTESIA_HOST], modelLicences: [] },
    conformance: ['stt@1'],
    ui: {
      label: 'Cartesia Ink STT (host finalize)',
      description: 'ink-2 or ink-whisper; a local VAD ends turns with finalize.',
      vendor: 'Cartesia',
      docsUrl: 'https://docs.cartesia.ai/api-reference/stt/websocket',
      slot: 'stt',
      fields: CARTESIA_MANUAL_UI_FIELDS,
    },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as CartesiaManualBinding;
    ctx.provide(
      Cap.stt,
      new CartesiaManualStt(ctx.net, await ctx.secret(''), binding, undefined, agentTerms(row)),
    );
  },
);

export const plugins = [cartesiaSttPlugin, cartesiaManualSttPlugin];
