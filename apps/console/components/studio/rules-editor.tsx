'use client';
import { RULE_LEXICONS, unsafeRulePattern } from '@winsendotai/ovo-contracts';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { useRowKeys } from '../forms/use-row-keys';
import { LinesInput } from './lines-input';

type Rules = NonNullable<AgentConfig['rules']>;
type Rule = Rules['global'][number];

/** Every `<question>=<answer>` a rule can resolve to: choice options and yes/no answers. */
function ruleTargets(config: AgentConfig): string[] {
  if (!config.decision?.enabled) return [];
  return config.decision.questions.flatMap((question) =>
    question.type === 'choice'
      ? question.options.map((option) => `${question.id}=${option.key}`)
      : question.type === 'noul'
        ? [`${question.id}=yes`, `${question.id}=no`]
        : [],
  );
}

/**
 * The instant rules tier (AGT-6): short replies resolved in memory, before the decision model is
 * asked. Each rule answers one decision question; a reply with a qualifier still goes to the model.
 */
export function RulesEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const rules = config.rules;
  const targets = ruleTargets(config);
  const rowKeys = useRowKeys(rules?.global.length ?? 0);
  const setRules = (next: Rules | undefined) => update({ ...config, rules: next });
  const editRule = (index: number, patch: Partial<Rule>) =>
    rules &&
    setRules({
      ...rules,
      global: rules.global.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)),
    });
  if (!targets.length)
    return (
      <Panel labelledBy="rules-title">
        <PanelHeader
          id="rules-title"
          title="Instant rules"
          badge={<StatusBadge tone="soft">Needs a decision question</StatusBadge>}
        />
        <div className="panel-body">
          <p className="muted">
            A rule answers a choice or yes/no decision question. Add one in the decision model panel
            first.
          </p>
        </div>
      </Panel>
    );
  if (!rules)
    return (
      <Panel labelledBy="rules-title">
        <PanelHeader
          id="rules-title"
          title="Instant rules"
          badge={<StatusBadge tone="soft">Not configured</StatusBadge>}
        />
        <div className="panel-body stack">
          <EmptyState title="Every reply goes to the decision model">
            Rules resolve the commonest short replies (&ldquo;yes&rdquo;, &ldquo;haan ji&rdquo;,
            &ldquo;speaking&rdquo;) in memory, saving the decision model&apos;s round trip.
            <button
              className="button primary"
              type="button"
              onClick={() => setRules({ enabled: true, global: [], listens: {} })}
            >
              Add instant rules
            </button>
          </EmptyState>
        </div>
      </Panel>
    );
  return (
    <Panel labelledBy="rules-title">
      <PanelHeader
        id="rules-title"
        title="Instant rules"
        badge={
          <StatusBadge tone={rules.enabled ? 'good' : 'soft'}>
            {rules.enabled ? `${rules.global.length} rules` : 'Disabled'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <Field label="Match rules before the decision model" htmlFor="rules-enabled">
          <input
            id="rules-enabled"
            type="checkbox"
            checked={rules.enabled}
            onChange={(event) => setRules({ ...rules, enabled: event.target.checked })}
          />
        </Field>
        {rules.global.map((rule, index) => {
          const id = `rule-${index}`;
          const unsafe = rule.patterns
            .map((pattern) => [pattern, unsafeRulePattern(pattern)] as const)
            .filter(([, reason]) => reason);
          return (
            <fieldset className="stack" key={rowKeys.keyAt(index)}>
              <legend>Rule {index + 1}</legend>
              <Field label="Answers" htmlFor={`${id}-intent`}>
                <select
                  id={`${id}-intent`}
                  value={rule.intent}
                  onChange={(event) => editRule(index, { intent: event.target.value })}
                >
                  {targets.map((target) => (
                    <option key={target} value={target}>
                      {target}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="toggle-row" role="group" aria-label={`Rule ${index + 1} lexicons`}>
                {RULE_LEXICONS.map((lexicon) => (
                  <label key={lexicon}>
                    <input
                      type="checkbox"
                      checked={rule.lexicons.includes(lexicon)}
                      onChange={(event) =>
                        editRule(index, {
                          lexicons: event.target.checked
                            ? [...rule.lexicons, lexicon]
                            : rule.lexicons.filter((entry) => entry !== lexicon),
                        })
                      }
                    />{' '}
                    {lexicon}
                  </label>
                ))}
              </div>
              <div className="form-grid">
                <Field label="Exact replies (one per line)" htmlFor={`${id}-phrases`}>
                  <LinesInput
                    id={`${id}-phrases`}
                    value={rule.phrases}
                    onChange={(phrases) => editRule(index, { phrases })}
                  />
                </Field>
                <Field
                  label="Keywords (one per line)"
                  htmlFor={`${id}-keywords`}
                  help={`Only in replies of ${rule.maxWords} words or fewer.`}
                >
                  <LinesInput
                    id={`${id}-keywords`}
                    value={rule.keywords}
                    onChange={(keywords) => editRule(index, { keywords })}
                  />
                </Field>
                <Field
                  label="Patterns (one per line)"
                  htmlFor={`${id}-patterns`}
                  help="Regular expressions over the whole lowercased reply, punctuation removed."
                  error={unsafe.length ? `${unsafe[0]![0]} ${unsafe[0]![1]}` : undefined}
                >
                  <LinesInput
                    id={`${id}-patterns`}
                    value={rule.patterns}
                    onChange={(patterns) => editRule(index, { patterns })}
                  />
                </Field>
              </div>
              <button
                className="text-button danger-text align-start"
                type="button"
                onClick={() => {
                  rowKeys.remove(index);
                  setRules({ ...rules, global: rules.global.filter((_, at) => at !== index) });
                }}
              >
                Remove rule {index + 1}
              </button>
            </fieldset>
          );
        })}
        {rules.global.some(
          (rule) =>
            !rule.phrases.length &&
            !rule.keywords.length &&
            !rule.patterns.length &&
            !rule.lexicons.length,
        ) && <Notice tone="danger">Every rule needs a phrase, keyword, pattern or lexicon.</Notice>}
        <button
          className="button align-start"
          type="button"
          onClick={() =>
            setRules({
              ...rules,
              global: [
                ...rules.global,
                {
                  intent: targets[0]!,
                  phrases: [],
                  keywords: [],
                  patterns: [],
                  lexicons: ['yes'],
                  maxWords: 4,
                },
              ],
            })
          }
        >
          Add a rule
        </button>
        <button
          className="text-button danger-text align-start"
          type="button"
          onClick={() => setRules(undefined)}
        >
          Remove instant rules
        </button>
      </div>
    </Panel>
  );
}
