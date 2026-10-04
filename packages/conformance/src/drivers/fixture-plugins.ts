import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { Cap, type FixtureTemplate, type NetFixtureScript } from '@winsendotai/ovo-contracts';
import { FixtureInference, fixtureLlmTemplate } from './fixture-llm.ts';
import {
  FIXTURE_HOST,
  FIXTURE_STT_CAPABILITIES,
  FixtureSpeechToText,
  fixtureSttTemplate,
} from './fixture-stt.ts';
import {
  FIXTURE_TTS_CAPABILITIES,
  FixtureTextToSpeech,
  fixtureTtsTemplate,
} from './fixture-tts.ts';

export const FIXTURE_PLUGIN_IDS = Object.freeze({
  stt: '@winsendotai/ovo-stt-fixture',
  tts: '@winsendotai/ovo-tts-fixture',
  llm: '@winsendotai/ovo-llm-fixture',
});

const runtime = { egressHosts: [FIXTURE_HOST], modelLicences: [] };

/**
 * Fixture-kind provider plugins (provider 'fixture'). They compose only with `fixtures: true`
 * and reach nothing but fixture.invalid through `ctx.net` (a FixtureNet).
 */
export const fixtureSttPlugin: PluginDefinition = definePlugin(
  {
    id: FIXTURE_PLUGIN_IDS.stt,
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'fixture',
    provider: 'fixture',
    provides: [`${Cap.stt}@2`],
    capabilities: FIXTURE_STT_CAPABILITIES,
    runtime,
    ui: { label: 'Fixture STT', description: 'Scripted speech-to-text for fixture calls' },
  },
  (ctx) => {
    ctx.provide(Cap.stt, new FixtureSpeechToText(ctx.net));
  },
);

export const fixtureTtsPlugin: PluginDefinition = definePlugin(
  {
    id: FIXTURE_PLUGIN_IDS.tts,
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'fixture',
    provider: 'fixture',
    provides: [`${Cap.tts}@2`],
    capabilities: FIXTURE_TTS_CAPABILITIES,
    runtime,
    ui: { label: 'Fixture TTS', description: 'Scripted text-to-speech for fixture calls' },
  },
  (ctx) => {
    ctx.provide(Cap.tts, new FixtureTextToSpeech(ctx.net));
  },
);

export const fixtureLlmPlugin: PluginDefinition = definePlugin(
  {
    id: FIXTURE_PLUGIN_IDS.llm,
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'fixture',
    provider: 'fixture',
    provides: [Cap.inference],
    optional: [Cap.usage],
    runtime,
    ui: { label: 'Fixture LLM', description: 'Scripted inference for fixture calls' },
  },
  (ctx) => {
    ctx.provide(Cap.inference, new FixtureInference(ctx.net, { usage: ctx.maybe(Cap.usage) }));
  },
);

/** Static scripts for a one-utterance call ("hello fixture"), for hosts without templates. */
export const fixtureScripts: Record<string, NetFixtureScript[]> = {
  [FIXTURE_PLUGIN_IDS.stt]: fixtureSttTemplate({
    format: FIXTURE_STT_CAPABILITIES.inputFormats![0]!,
    language: 'en-US',
    sessionId: 'fixture-session',
    turns: [{ atMs: 0, say: 'hello fixture' }],
  }),
};

export const fixtureTemplates: Record<string, FixtureTemplate> = {
  [FIXTURE_PLUGIN_IDS.stt]: fixtureSttTemplate,
  [FIXTURE_PLUGIN_IDS.tts]: fixtureTtsTemplate,
  [FIXTURE_PLUGIN_IDS.llm]: fixtureLlmTemplate,
};

/** The module shape a catalog entry loads (§2.3): plugins, fixtures and fixtureTemplates. */
export const fixtureProviderModule = Object.freeze({
  plugins: [fixtureSttPlugin, fixtureTtsPlugin, fixtureLlmPlugin],
  fixtures: fixtureScripts,
  fixtureTemplates,
});
