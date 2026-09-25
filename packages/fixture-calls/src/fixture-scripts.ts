import {
  fixtureTemplates as genericTemplates,
  fixtureSttPlugin,
  fixtureTtsPlugin,
} from '@winsendotai/ovo-conformance/drivers';
import type { AudioFormat, NetFixtureScript, ReleaseSelections } from '@winsendotai/ovo-contracts';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import { PluginRegistry as Registry } from '@winsendotai/ovo-runtime';
import type { FixtureCallInput, CallerScript } from './types.ts';

/** Prefer each installed provider's template, then its static fixture. Generic speech is last. */
export function selectFixtureScripts(
  input: FixtureCallInput,
  choices: ReleaseSelections,
  script: CallerScript,
  format: AudioFormat,
  sessionId: string,
  language: string,
  agentTexts: readonly string[],
) {
  const selections: ReleaseSelections = { ...choices };
  const scripts: NetFixtureScript[] = [];
  const generic = { stt: fixtureSttPlugin, tts: fixtureTtsPlugin };
  let sttMode: 'template' | 'static' | 'fixture-generic' | 'none' = 'none';
  let genericUsed = false;
  for (const slot of ['stt', 'tts', 'llm'] as const) {
    const choice = selections[slot];
    if (!choice) continue;
    const template = input.fixtureTemplates[choice.pluginId];
    const staticScripts = input.fixtures[choice.pluginId];
    if (template) {
      scripts.push(
        ...template({
          format,
          language,
          sessionId,
          turns: script.turns,
          agentTexts,
          tools: input.release?.config.tools ?? input.draft?.config.tools ?? [],
        }),
      );
      if (slot === 'stt') sttMode = 'template';
    } else if (staticScripts) {
      scripts.push(...staticScripts);
      if (slot === 'stt') sttMode = 'static';
    } else if (slot === 'stt' || slot === 'tts') {
      const replacement = generic[slot];
      const id = replacement.manifest.id;
      selections[slot] = {
        ...choice,
        pluginId: id,
        version: replacement.manifest.version,
        config: {},
      };
      const fixtureTemplate = genericTemplates[id];
      if (!fixtureTemplate) throw new Error(`fixture_unavailable: ${choice.pluginId}`);
      scripts.push(
        ...fixtureTemplate({ format, language, sessionId, turns: script.turns, agentTexts }),
      );
      if (slot === 'stt') sttMode = 'fixture-generic';
      genericUsed = true;
    }
  }
  const registry: PluginRegistry = genericUsed
    ? new Registry([...input.registry.list(), fixtureSttPlugin, fixtureTtsPlugin])
    : input.registry;
  return { selections, scripts, registry, sttMode };
}
