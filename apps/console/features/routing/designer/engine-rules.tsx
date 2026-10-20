'use client';
import { type RulesEngine, type RulesMatcher } from '@winsendotai/ovo-contracts';
import { optionsFrom, SelectField } from '../../../components/routing/fields';
import { Select } from '../../../components/ui/inputs';
import { blankMatcher } from '../../../lib/derive/routing-defaults';
import { moveItem, removeItem } from '../../../lib/derive/list-edit';
import { MATCHER_LABEL } from '../../../lib/derive/routing-labels';
import { MatcherEditor } from './matcher-editors';

const KINDS = optionsFrom(MATCHER_LABEL);

/** Matchers that decide without the caller saying anything, so a node of only these skips the question. */
export const NO_TURN_MATCHERS: readonly RulesMatcher['kind'][] = ['caller-id', 'time', 'variable'];

/** The rules engine: first matching rule wins; every condition of a rule must match. */
export function RulesEditor({
  engine,
  branchKeys,
  onChange,
  id,
}: {
  engine: RulesEngine;
  branchKeys: readonly string[];
  onChange: (engine: RulesEngine) => void;
  id: string;
}) {
  const setRules = (rules: RulesEngine['rules']) => onChange({ ...engine, rules });
  const replace = (r: number, rule: RulesEngine['rules'][number]) =>
    setRules(engine.rules.map((existing, i) => (i === r ? rule : existing)));
  return (
    <div className="rt-stack">
      <p className="muted">
        Rules need no model: the first rule whose conditions all match wins, with confidence 1.
        Caller number, time and call variable conditions need no reply, so a question made only of
        them decides on the opening turn.
      </p>
      <ol className="queue-rows" aria-label="Rules">
        {engine.rules.map((rule, r) => (
          <li key={r} className="rt-card">
            <div className="rt-card-head">
              <SelectField
                id={`${id}-rule-${r}-branch`}
                label={`Rule ${r + 1} chooses branch`}
                value={rule.branch}
                placeholder="Choose a branch…"
                options={branchKeys.map((k) => ({ value: k, label: k }))}
                onChange={(branch) => replace(r, { ...rule, branch })}
              />
              <span className="rt-row-actions">
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move rule ${r + 1} up`}
                  disabled={r === 0}
                  onClick={() => setRules(moveItem(engine.rules, r, -1))}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move rule ${r + 1} down`}
                  disabled={r === engine.rules.length - 1}
                  onClick={() => setRules(moveItem(engine.rules, r, 1))}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove rule ${r + 1}`}
                  disabled={engine.rules.length <= 1}
                  onClick={() => setRules(removeItem(engine.rules, r, 1))}
                >
                  Remove
                </button>
              </span>
            </div>
            <p className="muted rt-when">When all of these match</p>
            {rule.when.map((matcher, m) => (
              <div key={m} className="rt-matcher">
                <div className="rt-matcher-head">
                  <Select
                    aria-label={`Rule ${r + 1} condition ${m + 1} type`}
                    value={matcher.kind}
                    options={KINDS}
                    onChange={(kind) =>
                      replace(r, {
                        ...rule,
                        when: rule.when.map((w, i) =>
                          i === m ? blankMatcher(kind as RulesMatcher['kind']) : w,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Remove rule ${r + 1} condition ${m + 1}`}
                    disabled={rule.when.length <= 1}
                    onClick={() => replace(r, { ...rule, when: removeItem(rule.when, m, 1) })}
                  >
                    Remove
                  </button>
                </div>
                <MatcherEditor
                  id={`${id}-r${r}-m${m}`}
                  matcher={matcher}
                  onChange={(next) =>
                    replace(r, { ...rule, when: rule.when.map((w, i) => (i === m ? next : w)) })
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className="button small"
              disabled={rule.when.length >= 8}
              onClick={() => replace(r, { ...rule, when: [...rule.when, blankMatcher('dtmf')] })}
            >
              Add condition
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="button"
        disabled={engine.rules.length >= 64}
        onClick={() =>
          setRules([...engine.rules, { branch: branchKeys[0] ?? '', when: [blankMatcher('dtmf')] }])
        }
      >
        Add rule
      </button>
    </div>
  );
}
