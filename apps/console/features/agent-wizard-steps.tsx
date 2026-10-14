// The new-agent wizard's three step bodies. Split out of `agent-wizard.tsx` to stay under the
// module-size gate; each step is a pure view over `config`/`onChange`.
import type { AgentVoice, Slot } from '@winsendotai/ovo-contracts';
import type { AgentConfig } from '../lib/api';
import { SlotPicker } from '../components/plugins/slot-picker';
import type { PluginCatalog } from '../components/plugins/types';
import { SectionCard } from '../components/ui/section-card';
import { RadioCardGroup, type Choice } from '../components/ui/choice-card';
import { Switch } from '../components/ui/display';
import { ComboInput } from '../components/forms/combo-input';
import { COMMON_LANGUAGES, COMMON_TIMEZONES } from '../components/forms/locale-options';

// No 'decision': a new agent has no questions yet, so there is nothing for a decision model to
// answer. It is picked on the plugins page once the studio authors a question.
export const WIZARD_SLOTS: Slot[] = [
  'engine',
  'carrier',
  'stt',
  'tts',
  'llm',
  'vad',
  'turnDetector',
];

const MODE_CHOICES: Choice[] = [
  {
    value: 'announcement',
    title: 'Announcement',
    description: 'Approved message with no LLM',
    chips: ['No LLM'],
  },
  {
    value: 'faq',
    title: 'FAQ',
    description: 'Approved answers to common questions',
    chips: ['No LLM'],
  },
  {
    value: 'context',
    title: 'Context',
    description: 'Conversation grounded in supplied facts',
    chips: ['LLM, no tools'],
  },
  {
    value: 'agent',
    title: 'Agent',
    description: 'Controlled tools and conversation',
    chips: ['LLM + tools'],
  },
];

export function WizardBasicsStep({
  config,
  onChange,
}: {
  config: AgentConfig;
  onChange: (next: AgentConfig) => void;
}) {
  return (
    <SectionCard title="Basics" padding="prose">
      <div className="ui-stack">
        <label htmlFor="wizard-name">
          Name
          <input
            id="wizard-name"
            value={config.name}
            onChange={(event) => onChange({ ...config, name: event.target.value })}
            required
          />
        </label>
        <div className="ui-grid">
          <label htmlFor="wizard-language">
            Language
            <ComboInput
              id="wizard-language"
              value={config.language}
              options={COMMON_LANGUAGES}
              placeholder="en-IN"
              onChange={(value) => onChange({ ...config, language: value, locale: value })}
            />
          </label>
          <label htmlFor="wizard-timezone">
            Timezone
            <ComboInput
              id="wizard-timezone"
              value={config.timezone}
              options={COMMON_TIMEZONES}
              placeholder="Asia/Kolkata"
              onChange={(value) => onChange({ ...config, timezone: value })}
            />
          </label>
        </div>
        <fieldset>
          <legend>Mode</legend>
          <RadioCardGroup
            name="mode"
            groupLabel="Agent mode"
            value={config.mode}
            choices={MODE_CHOICES}
            onChange={(value) => onChange({ ...config, mode: value as AgentConfig['mode'] })}
          />
        </fieldset>
      </div>
    </SectionCard>
  );
}

export function WizardPluginsStep({
  config,
  voice,
  plugins,
  onChange,
}: {
  config: AgentConfig;
  voice: AgentVoice;
  plugins: PluginCatalog['plugins'];
  onChange: (next: AgentConfig) => void;
}) {
  return (
    <SectionCard
      title="Plugins"
      description="No carrier is preselected. Choose the one configured for your number when ready."
    >
      <div className="ui-stack">
        {WIZARD_SLOTS.filter(
          (slot) => slot !== 'llm' || (config.mode !== 'announcement' && config.mode !== 'faq'),
        ).map((slot) => (
          <SlotPicker
            key={slot}
            slot={slot}
            plugins={plugins}
            value={voice[slot]?.plugin}
            voice={voice}
            mode={config.mode}
            language={config.language}
            onChange={(plugin) =>
              onChange({
                ...config,
                voice: {
                  ...(config.voice ?? { textFilters: [], acknowledgements: [] }),
                  [slot]: { plugin, config: {} },
                },
              })
            }
          />
        ))}
      </div>
    </SectionCard>
  );
}

export function WizardBehaviorStep({
  config,
  onChange,
}: {
  config: AgentConfig;
  onChange: (next: AgentConfig) => void;
}) {
  return (
    <SectionCard title="Behavior essentials" padding="prose">
      <div className="ui-stack">
        <label htmlFor="wizard-message">
          {config.mode === 'announcement' ? 'Approved message' : 'Opening message'}
          <textarea
            id="wizard-message"
            value={config.message}
            onChange={(event) => onChange({ ...config, message: event.target.value })}
          />
        </label>
        {(config.mode === 'context' || config.mode === 'agent') && (
          <label htmlFor="wizard-context">
            Grounding context
            <textarea
              id="wizard-context"
              value={config.context}
              onChange={(event) => onChange({ ...config, context: event.target.value })}
            />
          </label>
        )}
        <Switch
          label="Record calls under the configured policy"
          checked={config.recording}
          onChange={(checked) => onChange({ ...config, recording: checked })}
        />
      </div>
    </SectionCard>
  );
}
