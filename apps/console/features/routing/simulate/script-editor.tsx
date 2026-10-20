'use client';
import { Select } from '../../../components/ui/inputs';
import { moveStep } from '../../../lib/derive/routing-edit';
import { SIMULATION_LIMITS, type SimulationTurn } from '../../../lib/types/routing-simulate';

const KINDS = [
  { value: 'speech', label: 'The caller says' },
  { value: 'dtmf', label: 'The caller presses' },
  { value: 'silence', label: 'The caller stays quiet' },
];

const blank = (kind: string): SimulationTurn =>
  kind === 'dtmf'
    ? { kind, digits: '1' }
    : kind === 'silence'
      ? { kind }
      : { kind: 'speech', text: '' };

/** The caller's side of the call, turn by turn. The router's opening greeting always comes first. */
export function ScriptEditor({
  turns,
  onChange,
}: {
  turns: SimulationTurn[];
  onChange: (turns: SimulationTurn[]) => void;
}) {
  const replace = (i: number, turn: SimulationTurn) =>
    onChange(turns.map((t, n) => (n === i ? turn : t)));
  return (
    <div className="rt-stack">
      <p className="muted">
        Turn 0 is the greeting the router speaks as soon as the call connects. Then the caller:
      </p>
      <ol className="queue-rows" aria-label="Caller turns">
        {turns.map((turn, i) => (
          <li key={i} className="queue-row">
            <Select
              aria-label={`Turn ${i + 1} type`}
              value={turn.kind}
              options={KINDS}
              onChange={(kind) => replace(i, blank(kind))}
            />
            <div className="queue-row-body">
              {turn.kind === 'speech' && (
                <input
                  aria-label={`Turn ${i + 1} words`}
                  value={turn.text}
                  maxLength={SIMULATION_LIMITS.textChars}
                  placeholder="mujhe naya credit card chahiye"
                  onChange={(e) => replace(i, { kind: 'speech', text: e.target.value })}
                />
              )}
              {turn.kind === 'dtmf' && (
                <input
                  aria-label={`Turn ${i + 1} keys`}
                  className="mono"
                  value={turn.digits}
                  maxLength={8}
                  onChange={(e) => replace(i, { kind: 'dtmf', digits: e.target.value })}
                />
              )}
              {turn.kind === 'silence' && (
                <span className="muted">An idle turn: the router may prompt the caller.</span>
              )}
            </div>
            <span className="rt-row-actions">
              <button
                type="button"
                className="text-button"
                aria-label={`Move turn ${i + 1} up`}
                disabled={i === 0}
                onClick={() => onChange(moveStep(turns, i, -1))}
              >
                Up
              </button>
              <button
                type="button"
                className="text-button"
                aria-label={`Move turn ${i + 1} down`}
                disabled={i === turns.length - 1}
                onClick={() => onChange(moveStep(turns, i, 1))}
              >
                Down
              </button>
              <button
                type="button"
                className="text-button"
                aria-label={`Remove turn ${i + 1}`}
                onClick={() => onChange(turns.filter((_, n) => n !== i))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="button"
        disabled={turns.length >= SIMULATION_LIMITS.turns}
        onClick={() => onChange([...turns, { kind: 'speech', text: '' }])}
      >
        Add a turn
      </button>
    </div>
  );
}
