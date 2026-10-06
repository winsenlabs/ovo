'use client';
import {
  DEFAULT_DIDNT_CATCH,
  DEFAULT_GIVE_UP,
  DEFAULT_REPEAT_PREFIX,
} from '@winsendotai/ovo-contracts';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Field, Panel, PanelHeader, StatusBadge } from '../primitives';
import { LinesInput } from './lines-input';

type Recovery = NonNullable<AgentConfig['recovery']>;

const DEFAULT_RECOVERY = (): Recovery => ({
  didntCatch: DEFAULT_DIDNT_CATCH,
  reprompts: {},
  maxAttempts: 2,
  exhausted: { action: 'end', line: DEFAULT_GIVE_UP },
});

/**
 * Repeat, didn't-catch and re-ask lines (AGT-12): what the agent says, without the LLM, when it
 * did not understand, and how many times in a row before it gives up.
 */
export function RecoveryEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const recovery = config.recovery;
  const questions = config.decision?.enabled ? config.decision.questions : [];
  const edit = (patch: Partial<Recovery>) => {
    if (recovery) update({ ...config, recovery: { ...recovery, ...patch } });
  };
  if (!recovery)
    return (
      <Panel labelledBy="recovery-title">
        <PanelHeader
          id="recovery-title"
          title="Repeat and didn't-catch"
          badge={<StatusBadge tone="soft">Not configured</StatusBadge>}
        />
        <div className="panel-body stack">
          <EmptyState title="Misunderstandings go to the LLM">
            With recovery lines, a caller who says &ldquo;sorry?&rdquo; hears the last line again,
            and a reply the agent did not understand gets a re-ask instead of an LLM round trip.
            <button
              className="button primary"
              type="button"
              onClick={() => update({ ...config, recovery: DEFAULT_RECOVERY() })}
            >
              Add recovery lines
            </button>
          </EmptyState>
        </div>
      </Panel>
    );
  const reprompt = (id: string, line: string) => {
    const reprompts = { ...recovery.reprompts };
    if (line.trim()) reprompts[id] = line;
    else delete reprompts[id];
    edit({ reprompts });
  };
  return (
    <Panel labelledBy="recovery-title">
      <PanelHeader
        id="recovery-title"
        title="Repeat and didn't-catch"
        badge={<StatusBadge tone="good">{recovery.maxAttempts} re-asks, then give up</StatusBadge>}
      />
      <div className="panel-body stack">
        <Field label="Didn't-catch line" htmlFor="recovery-didnt-catch">
          <input
            id="recovery-didnt-catch"
            value={recovery.didntCatch}
            onChange={(event) => edit({ didntCatch: event.target.value })}
          />
        </Field>
        {questions.map((question) => (
          <Field
            key={question.id}
            label={`Re-ask for ${question.id}`}
            htmlFor={`recovery-reprompt-${question.id}`}
            help="Spoken instead of the didn't-catch line when this question wants clarification."
          >
            <input
              id={`recovery-reprompt-${question.id}`}
              value={recovery.reprompts[question.id] ?? ''}
              onChange={(event) => reprompt(question.id, event.target.value)}
            />
          </Field>
        ))}
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={recovery.repeat !== undefined}
            onChange={(event) =>
              edit({
                repeat: event.target.checked
                  ? { prefix: DEFAULT_REPEAT_PREFIX, phrases: [] }
                  : undefined,
              })
            }
          />
          <span>
            <strong>Repeat the last line on request</strong>
            <small>
              &ldquo;Sorry?&rdquo;, &ldquo;come again&rdquo;, &ldquo;kya?&rdquo; and the phrases
              below.
            </small>
          </span>
        </label>
        {recovery.repeat && (
          <div className="form-grid">
            <Field label="Said before the repeat" htmlFor="recovery-repeat-prefix">
              <input
                id="recovery-repeat-prefix"
                value={recovery.repeat.prefix}
                onChange={(event) =>
                  edit({ repeat: { ...recovery.repeat!, prefix: event.target.value } })
                }
              />
            </Field>
            <Field label="More ways to ask (one per line)" htmlFor="recovery-repeat-phrases">
              <LinesInput
                id="recovery-repeat-phrases"
                value={recovery.repeat.phrases}
                onChange={(phrases) => edit({ repeat: { ...recovery.repeat!, phrases } })}
              />
            </Field>
          </div>
        )}
        <div className="form-grid">
          <Field label="Misses in a row before giving up" htmlFor="recovery-attempts">
            <input
              id="recovery-attempts"
              type="number"
              min={1}
              max={5}
              value={recovery.maxAttempts}
              onChange={(event) => edit({ maxAttempts: Number(event.target.value) })}
            />
          </Field>
          <Field label="Then" htmlFor="recovery-exhausted">
            <select
              id="recovery-exhausted"
              value={recovery.exhausted.action}
              onChange={(event) =>
                edit({
                  exhausted: {
                    ...recovery.exhausted,
                    action: event.target.value as Recovery['exhausted']['action'],
                  },
                })
              }
            >
              <option value="end">End the call with the give-up line</option>
              <option value="llm">Hand the turn to the LLM</option>
            </select>
          </Field>
        </div>
        {recovery.exhausted.action === 'end' && (
          <Field label="Give-up line" htmlFor="recovery-give-up">
            <input
              id="recovery-give-up"
              value={recovery.exhausted.line}
              onChange={(event) =>
                edit({ exhausted: { ...recovery.exhausted, line: event.target.value } })
              }
            />
          </Field>
        )}
        <button
          className="text-button danger-text align-start"
          type="button"
          onClick={() => update({ ...config, recovery: undefined })}
        >
          Remove recovery lines
        </button>
      </div>
    </Panel>
  );
}
