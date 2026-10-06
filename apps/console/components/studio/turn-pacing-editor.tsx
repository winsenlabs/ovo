'use client';
import type { AgentConfig } from '../../lib/api';
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { LinesInput } from './lines-input';

/** The distribution's default turn detector (packages/distribution/src/defaults.ts). */
export const DEFAULT_TURN_DETECTOR = '@winsendotai/ovo-turn-detector-default';
/** LAT-9's default: a clause mark ends the first spoken segment only after this many words. */
export const DEFAULT_MIN_FIRST_WORDS = 3;
const DEFAULT_FILLER = () => ({ lines: ['Hmm, one moment.'], afterMs: 600 });

type Filler = { lines: string[]; afterMs: number };
type Speculation = NonNullable<NonNullable<AgentConfig['decision']>['speculation']>;

/**
 * Wave 4's per-agent turn knobs: backchannels (AGT-9), the slow-reply filler (LAT-6), how far the
 * agent works ahead of the caller (LAT-3, LAT-4) and the first spoken segment (LAT-9). The first two
 * live in the turn detector's row config, so they need a selected turn detector.
 */
export function TurnPacingEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const detector = config.voice?.turnDetector;
  const row = (detector?.config ?? {}) as { backchannelsEnabled?: boolean; filler?: Filler | null };
  const patchDetector = (next: Record<string, unknown>) => {
    if (!config.voice) return;
    update({
      ...config,
      voice: {
        ...config.voice,
        turnDetector: {
          plugin: detector?.plugin ?? DEFAULT_TURN_DETECTOR,
          ...(detector?.binding ? { binding: detector.binding } : {}),
          config: { ...row, ...next },
        },
      },
    });
  };
  const speculation: Speculation = config.decision?.speculation ?? {};
  const patchSpeculation = (next: Speculation) => {
    if (!config.decision) return;
    const merged = { ...speculation, ...next };
    update({
      ...config,
      decision: {
        ...config.decision,
        speculation: Object.keys(merged).length ? merged : undefined,
      },
    });
  };
  const filler = row.filler ?? null;
  const minFirstWords = config.reply?.minFirstWords;
  return (
    <Panel labelledBy="turn-pacing-title">
      <PanelHeader
        id="turn-pacing-title"
        title="Turn pacing"
        badge={
          <StatusBadge tone={speculation.llm ? 'warning' : 'soft'}>
            {speculation.llm ? 'Speculative LLM on' : 'Wave 4 defaults'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        {!config.voice ? (
          <Notice>
            Backchannels and filler lines live in the turn detector&rsquo;s settings. Select plugins
            for this agent on its Plugins page to edit them here.
          </Notice>
        ) : (
          <>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={row.backchannelsEnabled !== false}
                onChange={(event) => patchDetector({ backchannelsEnabled: event.target.checked })}
              />
              <span>
                <strong>Ignore acknowledgements while the agent speaks</strong>
                <small>
                  &ldquo;Haan&rdquo;, &ldquo;ok theek hai&rdquo; or &ldquo;mm hmm&rdquo; over the
                  agent neither interrupts it nor starts a turn. Off lets any word barge in.
                </small>
              </span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={filler !== null}
                onChange={(event) =>
                  patchDetector({ filler: event.target.checked ? DEFAULT_FILLER() : null })
                }
              />
              <span>
                <strong>Filler line on slow replies</strong>
                <small>
                  Plays when a reply has no audio yet, at most once per turn. Enable the speech
                  cache so the lines are pre-rendered.
                </small>
              </span>
            </label>
            {filler && (
              <div className="form-grid">
                <Field label="Filler lines (one per line)" htmlFor="pacing-filler-lines">
                  <LinesInput
                    id="pacing-filler-lines"
                    value={filler.lines}
                    onChange={(lines) =>
                      patchDetector({ filler: { ...filler, lines: lines.slice(0, 10) } })
                    }
                  />
                </Field>
                <Field
                  label="Play after (ms)"
                  htmlFor="pacing-filler-after"
                  help="100 to 10000; counted from the end of the caller's turn."
                >
                  <input
                    id="pacing-filler-after"
                    type="number"
                    min={100}
                    max={10000}
                    value={filler.afterMs}
                    onChange={(event) =>
                      patchDetector({
                        filler: {
                          ...filler,
                          afterMs: Math.min(
                            10000,
                            Math.max(100, Number(event.target.value) || 600),
                          ),
                        },
                      })
                    }
                  />
                </Field>
                {!filler.lines.length && (
                  <Notice tone="danger">Add a filler line, or turn the filler off.</Notice>
                )}
              </div>
            )}
          </>
        )}
        {config.decision ? (
          <>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={speculation.partials !== false}
                onChange={(event) => patchSpeculation({ partials: event.target.checked })}
              />
              <span>
                <strong>Decide on partial transcripts</strong>
                <small>
                  The decision model judges the caller&rsquo;s words while they are still speaking
                  and the turn reuses that verdict when the final words match.
                </small>
              </span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={speculation.llm === true}
                onChange={(event) => patchSpeculation({ llm: event.target.checked })}
              />
              <span>
                <strong>Ask the LLM alongside the decision</strong>
                <small>
                  Faster LLM turns; calls that turn out not to be needed are still billed.
                </small>
              </span>
            </label>
            {speculation.llm && (
              <Notice tone="warning">
                Speculative LLM calls are billed even when aborted, and gpt-6-luna&rsquo;s price
                card is provisional, so this spend is not reliably priced. Keep it off until the LLM
                has a firm price card.
              </Notice>
            )}
          </>
        ) : (
          <Notice>Speculation applies once the agent has a decision policy.</Notice>
        )}
        <Field
          label="Words before the first clause break"
          htmlFor="pacing-min-first-words"
          help={`A streamed reply's first audio may end at a comma only after this many words (default ${DEFAULT_MIN_FIRST_WORDS}). 0 cuts at the first comma; higher avoids a short clip and then a gap.`}
        >
          <input
            id="pacing-min-first-words"
            type="number"
            min={0}
            max={12}
            placeholder={String(DEFAULT_MIN_FIRST_WORDS)}
            value={minFirstWords ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              // The whole of `reply` today is this one knob (contracts AgentReplyPacing).
              update({
                ...config,
                reply:
                  raw === ''
                    ? undefined
                    : { minFirstWords: Math.min(12, Math.max(0, Math.round(Number(raw)))) },
              });
            }}
          />
        </Field>
      </div>
    </Panel>
  );
}
