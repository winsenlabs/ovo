'use client';
import type { AgentConfig } from '../../lib/api';
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { LinesInput } from './lines-input';

/** `AgentConfig.compliance` (contracts agent-compliance.ts), typed here structurally. */
export interface CallingHours {
  start: string;
  end: string;
  days?: number[];
  timezone?: string;
}
export interface AgentCompliance {
  callingHours?: CallingHours;
  disclosure?: { text: string };
  optOut?: { enabled: boolean; phrases: string[]; closingLine: string };
}
type WithCompliance = AgentConfig & { compliance?: AgentCompliance };

/** RBI's fair practices code for recovery calls: 08:00 to 19:00, the borrower's local time. */
export const DEFAULT_CALLING_HOURS = (): CallingHours => ({ start: '08:00', end: '19:00' });
/** The POC's disclosure line (poc/lib/flow.js `recording`). */
export const DEFAULT_DISCLOSURE = 'Please note that this call is recorded for quality purposes.';
export const DEFAULT_OPT_OUT = () => ({
  enabled: true,
  phrases: [] as string[],
  closingLine: "Understood. We won't call this number again. Thank you, goodbye.",
});
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Calling hours, the recording disclosure and the caller's opt-out, per agent. */
export function ComplianceEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const compliance = (config as WithCompliance).compliance ?? {};
  const agentMode = config.mode === 'agent';
  const patch = (next: Partial<AgentCompliance>) => {
    const merged = { ...compliance, ...next };
    for (const key of Object.keys(merged) as (keyof AgentCompliance)[])
      if (merged[key] === undefined) delete merged[key];
    update({
      ...config,
      compliance: Object.keys(merged).length ? merged : undefined,
    } as WithCompliance);
  };
  const hours = compliance.callingHours;
  const hoursError = hours && hours.start >= hours.end ? 'End must be after start.' : undefined;
  const enabled = [
    hours && 'hours',
    compliance.disclosure && 'disclosure',
    compliance.optOut?.enabled && 'opt-out',
  ].filter(Boolean);
  return (
    <Panel labelledBy="compliance-title">
      <PanelHeader
        id="compliance-title"
        title="Outbound compliance"
        badge={
          <StatusBadge tone={enabled.length ? 'good' : 'soft'}>
            {enabled.length ? enabled.join(' · ') : 'Not configured'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={hours !== undefined}
            onChange={(event) =>
              patch({ callingHours: event.target.checked ? DEFAULT_CALLING_HOURS() : undefined })
            }
          />
          <span>
            <strong>Restrict calling hours</strong>
            <small>
              Campaign admission and manual dials refuse outside this window. A campaign may set its
              own window instead.
            </small>
          </span>
        </label>
        {hours && (
          <div className="form-grid">
            <Field label="From" htmlFor="compliance-start">
              <input
                id="compliance-start"
                type="time"
                value={hours.start}
                onChange={(event) =>
                  patch({ callingHours: { ...hours, start: event.target.value } })
                }
              />
            </Field>
            <Field label="Until (exclusive)" htmlFor="compliance-end" error={hoursError}>
              <input
                id="compliance-end"
                type="time"
                value={hours.end}
                onChange={(event) => patch({ callingHours: { ...hours, end: event.target.value } })}
              />
            </Field>
            <Field
              label="Timezone"
              htmlFor="compliance-timezone"
              help={`Blank uses the agent's timezone (${config.timezone}).`}
            >
              <input
                id="compliance-timezone"
                placeholder={config.timezone}
                value={hours.timezone ?? ''}
                onChange={(event) => {
                  const { timezone: _timezone, ...rest } = hours;
                  const timezone = event.target.value.trim();
                  patch({ callingHours: timezone ? { ...rest, timezone } : rest });
                }}
              />
            </Field>
            <fieldset className="field">
              <legend>Days</legend>
              <div className="button-row">
                {WEEKDAYS.map((label, index) => {
                  const day = index + 1;
                  const days = hours.days ?? [1, 2, 3, 4, 5, 6, 7];
                  return (
                    <label key={label} className="toggle-row">
                      <input
                        type="checkbox"
                        checked={days.includes(day)}
                        disabled={days.length === 1 && days.includes(day)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...days, day].sort((a, b) => a - b)
                            : days.filter((value) => value !== day);
                          const { days: _days, ...rest } = hours;
                          patch({
                            callingHours: next.length === 7 ? rest : { ...rest, days: next },
                          });
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        )}
        {!agentMode && <Notice>The disclosure line and the opt-out intent need agent mode.</Notice>}
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={compliance.disclosure !== undefined}
            disabled={!agentMode}
            onChange={(event) =>
              patch({ disclosure: event.target.checked ? { text: DEFAULT_DISCLOSURE } : undefined })
            }
          />
          <span>
            <strong>Recording disclosure</strong>
            <small>
              Spoken first on every call, before the opening, and cannot be talked over. A fixed
              line, so it is pre-rendered with the speech cache.
            </small>
          </span>
        </label>
        {compliance.disclosure && (
          <Field label="Disclosure line" htmlFor="compliance-disclosure">
            <input
              id="compliance-disclosure"
              maxLength={500}
              value={compliance.disclosure.text}
              onChange={(event) => patch({ disclosure: { text: event.target.value } })}
            />
          </Field>
        )}
        {compliance.disclosure && !compliance.disclosure.text.trim() && (
          <Notice tone="danger">Write the disclosure line, or turn the disclosure off.</Notice>
        )}
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={compliance.optOut?.enabled === true}
            disabled={!agentMode}
            onChange={(event) =>
              patch({
                optOut: event.target.checked
                  ? { ...DEFAULT_OPT_OUT(), ...compliance.optOut, enabled: true }
                  : undefined,
              })
            }
          />
          <span>
            <strong>Honour &ldquo;stop calling me&rdquo;</strong>
            <small>
              The number goes on the do-not-call list, the closing line plays and the call ends with
              disposition <code>opted_out</code>. English, Hinglish, Hindi and Tamil phrases are
              built in.
            </small>
          </span>
        </label>
        {compliance.optOut?.enabled && (
          <>
            <Field label="Closing line" htmlFor="compliance-opt-out-line">
              <input
                id="compliance-opt-out-line"
                maxLength={500}
                value={compliance.optOut.closingLine}
                onChange={(event) =>
                  patch({ optOut: { ...compliance.optOut!, closingLine: event.target.value } })
                }
              />
            </Field>
            <Field
              label="More opt-out phrases (one per line)"
              htmlFor="compliance-opt-out-phrases"
              help="Matched as whole words anywhere in what the caller says."
            >
              <LinesInput
                id="compliance-opt-out-phrases"
                value={compliance.optOut.phrases}
                onChange={(phrases) => patch({ optOut: { ...compliance.optOut!, phrases } })}
              />
            </Field>
          </>
        )}
      </div>
    </Panel>
  );
}
