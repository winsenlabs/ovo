'use client';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { LinesInput } from './lines-input';

type Idle = NonNullable<AgentConfig['idle']>;

/** The POC's no-input lines (poc/lib/flow.js), which tested well on Indian English calls. */
const DEFAULT_IDLE = (): Idle => ({
  timeoutMs: 8000,
  prompts: ['Hello? Can you hear me?'],
  finalLine: "I'm unable to hear you, so I'll call back later. Goodbye.",
});

/**
 * Caller silence, per agent (AGT-11). Each prompt is a turn in the conversation history, and the
 * final line ends the call as no input once it has played.
 */
export function IdleEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const idle = config.idle;
  const edit = (patch: Partial<Idle>) => {
    if (idle) update({ ...config, idle: { ...idle, ...patch } });
  };
  if (!idle)
    return (
      <Panel labelledBy="idle-title">
        <PanelHeader
          id="idle-title"
          title="Caller silence"
          badge={<StatusBadge tone="soft">Turn detector default</StatusBadge>}
        />
        <div className="panel-body stack">
          <EmptyState title="Silence uses the turn detector's prompt">
            Without a policy a silent caller hears the turn detector's one English prompt, then the
            call hangs up with no goodbye. Give this agent its own escalating prompts and a closing
            line instead.
            <button
              className="button primary"
              type="button"
              onClick={() => update({ ...config, idle: DEFAULT_IDLE() })}
            >
              Add silence prompts
            </button>
          </EmptyState>
        </div>
      </Panel>
    );
  return (
    <Panel labelledBy="idle-title">
      <PanelHeader
        id="idle-title"
        title="Caller silence"
        badge={
          <StatusBadge tone="good">
            {idle.prompts.length} prompt{idle.prompts.length === 1 ? '' : 's'}
            {idle.finalLine ? ' + closing line' : ''}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <Field
          label="Silence before a prompt (seconds)"
          htmlFor="idle-timeout"
          help="Counted from the end of the agent's last line."
        >
          <input
            id="idle-timeout"
            type="number"
            min={1}
            max={120}
            value={idle.timeoutMs / 1000}
            onChange={(event) => edit({ timeoutMs: Math.round(Number(event.target.value) * 1000) })}
          />
        </Field>
        <Field
          label="Prompts, one per silence (one per line)"
          htmlFor="idle-prompts"
          help="Spoken in order. Anything the caller says starts them over."
        >
          <LinesInput
            id="idle-prompts"
            value={idle.prompts}
            onChange={(prompts) => edit({ prompts })}
          />
        </Field>
        <Field
          label="Closing line"
          htmlFor="idle-final"
          help="Spoken after the last prompt goes unanswered; the call then ends as no input."
        >
          <input
            id="idle-final"
            value={idle.finalLine ?? ''}
            onChange={(event) => {
              const finalLine = event.target.value.trim() ? event.target.value : undefined;
              update({ ...config, idle: { ...idle, finalLine } });
            }}
          />
        </Field>
        {!idle.prompts.length && !idle.finalLine && (
          <Notice tone="danger">Add a prompt or a closing line, or remove the policy.</Notice>
        )}
        <button
          className="text-button danger-text align-start"
          type="button"
          onClick={() => update({ ...config, idle: undefined })}
        >
          Remove silence prompts
        </button>
      </div>
    </Panel>
  );
}
