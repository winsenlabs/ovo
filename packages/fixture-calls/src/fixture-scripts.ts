import {
  fixtureTemplates as genericTemplates,
  fixtureSttPlugin,
  fixtureTtsPlugin,
} from '@winsendotai/ovo-conformance/drivers';
import type {
  AudioFormat,
  FixtureTemplate,
  NetFixtureScript,
  ReleaseSelections,
} from '@winsendotai/ovo-contracts';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import { PluginRegistry as Registry } from '@winsendotai/ovo-runtime';
import type { FixtureCallInput, CallerScript } from './types.ts';
import { planSttReplay, type SttReplayPlan } from './stt-replay-plan.ts';

/** Prefer each installed provider's template, then its static fixture. Generic speech is last. */
export function selectFixtureScripts(
  input: FixtureCallInput,
  choices: ReleaseSelections,
  script: CallerScript,
  format: AudioFormat,
  sessionId: string,
  language: string,
  agentTexts: readonly string[],
  gateStt = false,
) {
  const selections: ReleaseSelections = { ...choices };
  const scripts: NetFixtureScript[] = [];
  const generic = { stt: fixtureSttPlugin, tts: fixtureTtsPlugin };
  let sttMode: 'template' | 'static' | 'fixture-generic' | 'none' = 'none';
  let genericUsed = false;
  let sttReplay: SttReplayPlan | undefined;
  let ttsTemplate: ((text: string) => NetFixtureScript[]) | undefined;
  const templateInput = {
    format,
    language,
    sessionId,
    turns: script.turns,
    tools: input.release?.config.tools ?? input.draft?.config.tools ?? [],
  };
  const deferTts = (template: FixtureTemplate) => {
    ttsTemplate = (text) => template({ ...templateInput, agentTexts: [text] });
  };
  // 'decision' needs no special handling — no replay, no deferral — but it must be iterated, or a
  // selected decision plugin's scripted exchange is silently dropped and its first POST has no
  // script to match. There is no generic replacement for it: `fixtureUnavailable` refuses the call
  // at validation instead of a fixture call inventing answers a vendor never gave.
  for (const slot of ['stt', 'tts', 'llm', 'decision'] as const) {
    const choice = selections[slot];
    if (!choice) continue;
    const template = input.fixtureTemplates[choice.pluginId];
    const staticScripts = input.fixtures[choice.pluginId];
    if (template) {
      if (slot === 'stt' && gateStt) {
        sttReplay = planSttReplay(template, { ...templateInput, agentTexts });
        sttMode = 'template';
        continue;
      }
      if (slot === 'tts') {
        deferTts(template);
        continue;
      }
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
      if (slot === 'stt' && gateStt)
        throw new Error('fixture_unavailable: confirmed write requires a templated STT replay');
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
      if (slot === 'tts') deferTts(fixtureTemplate);
      else if (gateStt)
        sttReplay = planSttReplay(fixtureTemplate, { ...templateInput, agentTexts });
      else scripts.push(...fixtureTemplate({ ...templateInput, agentTexts }));
      if (slot === 'stt') sttMode = 'fixture-generic';
      genericUsed = true;
    }
  }
  if (gateStt && !sttReplay)
    throw new Error('fixture_unavailable: confirmed write requires a templated STT replay');
  const registry: PluginRegistry = genericUsed
    ? new Registry([...input.registry.list(), fixtureSttPlugin, fixtureTtsPlugin])
    : input.registry;
  return { selections, scripts, registry, sttMode, ttsTemplate, sttReplay };
}
