import { type Clock, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import {
  EgressBlockedError,
  installEgressSentinel,
  withEgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { manifestKeys, type PluginRegistry } from '@winsendotai/ovo-runtime';
import { normalizeAgentConfig, validateSelections } from '@winsendotai/ovo-session-host';
import { defaultCallerScript, predictedAgentTexts } from './default-script.ts';
import { executeFixtureCall } from './execute.ts';
import { selectFixtureScripts } from './fixture-scripts.ts';
import type { FixtureCallInput, FixtureCallResult } from './types.ts';
export type {
  CallerScript,
  FixtureCallEvent,
  FixtureCallInput,
  FixtureCallResult,
  FixtureRecordingWriter,
} from './types.ts';

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function selectedCarrierMatches(input: FixtureCallInput, selections: ReleaseSelections): boolean {
  const choice = selections.carrier;
  if (!choice) return false;
  const manifest = input.registry.get(choice.pluginId)?.manifest;
  const provider = manifest ? manifestKeys(manifest).manifest.provider : undefined;
  return (
    choice.pluginId === input.carrier.pluginId &&
    (provider === input.carrier.ingress.carrierId ||
      choice.pluginId === input.carrier.ingress.carrierId)
  );
}

function selectionsFromVoice(
  config: NonNullable<FixtureCallInput['release']>['config'],
  registry: PluginRegistry,
): ReleaseSelections {
  const choices: ReleaseSelections = {};
  for (const slot of [
    'engine',
    'carrier',
    'stt',
    'tts',
    'llm',
    'vad',
    'turnDetector',
    'audioFilter',
  ] as const) {
    const voice = config.voice?.[slot];
    if (!voice) continue;
    const installed = registry.get(voice.plugin);
    if (!installed) throw new Error(`plugin_not_installed: ${voice.plugin}`);
    choices[slot] = {
      pluginId: voice.plugin,
      version: installed.manifest.version,
      ...(voice.binding ? { bindingId: voice.binding } : {}),
      config: voice.config,
    };
  }
  config.voice?.textFilters.forEach((choice, index) => {
    const installed = registry.get(choice.plugin);
    if (!installed) throw new Error(`plugin_not_installed: ${choice.plugin}`);
    choices[`textFilter:${index}`] = {
      pluginId: choice.plugin,
      version: installed.manifest.version,
      ...(choice.binding ? { bindingId: choice.binding } : {}),
      config: choice.config,
    };
  });
  return choices;
}

/** Runs entirely with an in-memory network and carrier; no dial, REST control or cost reservation. */
export function runFixtureCall(input: FixtureCallInput): {
  callId: string;
  done: Promise<FixtureCallResult>;
} {
  const source = input.release ?? input.draft;
  if (!source) throw new TypeError('release or draft is required');
  const clock = input.clock ?? realClock;
  const callId = input.callId ?? crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId))
    throw new TypeError('Fixture call ID must be a UUID');
  const config = normalizeAgentConfig(
    structuredClone(source.config),
    input.registry,
    Object.fromEntries(Object.values(source.providerBindings ?? {}).map((row) => [row.id, row])),
    input.defaults ?? { engine: source.selections?.engine?.pluginId ?? '' },
  ).config;
  if (config.recording && !input.recording)
    throw new Error('fixture_unavailable: recording port is required for this release');
  const release = { ...source, config };
  const choices =
    release.selections && Object.keys(release.selections).length
      ? release.selections
      : selectionsFromVoice(config, input.registry);
  if (!selectedCarrierMatches(input, choices))
    throw new Error('fixture_unavailable: selected carrier ingress does not match the release');
  const script =
    input.callerScript && input.callerScript !== 'default'
      ? input.callerScript
      : defaultCallerScript(config);
  for (const turn of script.turns)
    if (!Number.isFinite(turn.atMs) || turn.atMs < 0)
      throw new TypeError('callerScript atMs must be nonnegative');
  const format = input.carrier.ingress.capabilities.media.formats[0];
  if (!format) throw new Error('fixture_unavailable: selected carrier has no media format');
  const setupSentinel = installEgressSentinel({ allowLoopback: false });
  let fixture: ReturnType<typeof selectFixtureScripts>;
  try {
    fixture = selectFixtureScripts(
      input,
      choices,
      script,
      format,
      callId,
      config.language,
      input.agentTexts ?? predictedAgentTexts(config),
    );
  } finally {
    setupSentinel.restore();
  }
  const available = new Set([
    ...Object.keys(input.fixtures),
    ...Object.keys(input.fixtureTemplates),
    ...['stt', 'tts'].flatMap((slot) => {
      const choice = fixture.selections[slot as 'stt' | 'tts'];
      return choice?.pluginId.startsWith('@winsendotai/ovo-') &&
        choice.pluginId.endsWith('-fixture')
        ? [choice.pluginId]
        : [];
    }),
  ]);
  const issues = validateSelections(
    {
      config,
      selections: fixture.selections,
      registry: fixture.registry,
      fixturePluginIds: [...available],
      fixtureTemplatePluginIds: Object.keys(input.fixtureTemplates),
      legacyProviderBindings: release.providerBindings,
    },
    'test',
  );
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length)
    throw new Error(errors.map((issue) => `${issue.code}: ${issue.message}`).join('; '));
  const done = withEgressSentinel(
    async (sentinel) => {
      const result = await executeFixtureCall(
        { ...input, release },
        callId,
        clock,
        script,
        fixture,
        format,
        issues,
      );
      if (sentinel.attempts.length) throw new EgressBlockedError(sentinel.attempts.join(', '));
      return result;
    },
    { allowLoopback: false },
  );
  return { callId, done };
}
