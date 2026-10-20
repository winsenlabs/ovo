'use client';
import type { RouteLines } from '@winsendotai/ovo-contracts';
import { useMemo } from 'react';
import { AgentRefEditor } from '../../../components/routing/agent-ref';
import { LinesEditor } from '../../../components/routing/lines-editor';
import {
  NumberField,
  SelectField,
  SwitchField,
  TagsField,
} from '../../../components/routing/fields';
import { IssueList } from '../../../components/routing/issue-list';
import { DataTableV2, type ColumnV2 } from '../../../components/ui/data-table-v2';
import { SectionCard } from '../../../components/ui/section-card';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { lineRows, type LineRow } from '../../../lib/derive/routing-lines';
import { useDesigner } from './designer-context';

const LANGUAGE = /^[a-z]{2,3}$/;

function LinesTable({ rows, fallbackLanguage }: { rows: LineRow[]; fallbackLanguage: string }) {
  const columns: ColumnV2<LineRow>[] = [
    { id: 'label', header: 'Spoken line', cell: (r) => r.label },
    {
      id: 'languages',
      header: 'Languages',
      cell: (r) => (
        <span className="rt-badges">
          {r.languages.map((l) => (
            <span key={l} className="ds-chip">
              {l}
            </span>
          ))}
          {r.missingDefault && (
            <StatusBadgeV2 tone="danger" size="sm" label={`Missing ${fallbackLanguage}`} />
          )}
          {r.unallowed.map((l) => (
            <StatusBadgeV2 key={l} tone="warn" size="sm" label={`${l} not allowed`} />
          ))}
        </span>
      ),
    },
  ];
  return (
    <DataTableV2
      label="Every spoken line"
      rows={rows}
      columns={columns}
      rowKey={(r) => r.path.join('.')}
      density="compact"
    />
  );
}

/** Languages, the greeting and idle prompts, router limits and the two agents, with every line audited. */
export function LinesTab() {
  const { draft, edit, index, canEdit, agents } = useDesigner();
  const rows = useMemo(() => lineRows(draft), [draft]);
  const { language } = draft;
  const set = (patch: Partial<typeof draft>) => edit((d) => ({ ...d, ...patch }));
  const badAllowed = language.allowed.filter((l) => !LANGUAGE.test(l));
  const idle = draft.idle;
  const setPrompts = (prompts: RouteLines[]) => idle && set({ idle: { ...idle, prompts } });
  return (
    <fieldset className="rt-readonly rt-stack rt-pad" disabled={!canEdit}>
      <SectionCard
        title="Languages"
        description="Callers are answered in their language when the router has a line for it, else the default."
      >
        <IssueList issues={index.bySection.languages} />
        <div className="rt-grid">
          <SelectField
            id="lang-default"
            label="Default language"
            value={language.default}
            options={[...new Set([language.default, ...language.allowed])].map((l) => ({
              value: l,
              label: l,
            }))}
            onChange={(next) =>
              set({
                language: {
                  default: next,
                  allowed: language.allowed.includes(next)
                    ? language.allowed
                    : [...language.allowed, next],
                },
              })
            }
          />
          <TagsField
            id="lang-allowed"
            label="Allowed languages"
            values={language.allowed}
            placeholder="hi"
            help="Language codes like en, hi, ta. Every line needs the default language."
            error={badAllowed.length ? `Not a language code: ${badAllowed.join(', ')}` : undefined}
            onChange={(allowed) => set({ language: { default: language.default, allowed } })}
          />
        </div>
      </SectionCard>
      <SectionCard title="What the router says">
        <IssueList issues={index.bySection.lines} />
        <LinesEditor
          label="Greeting"
          required
          value={draft.greeting}
          onChange={(greeting) => greeting && set({ greeting })}
        />
        <LinesEditor
          label="Before connecting (optional)"
          value={draft.connecting}
          onChange={(connecting) => set({ connecting })}
        />
        <SwitchField
          label="Prompt a caller who goes quiet"
          checked={idle !== undefined}
          onChange={(on) =>
            set({
              idle: on
                ? { timeoutMs: 8000, prompts: [{ [language.default]: 'Are you still there?' }] }
                : undefined,
            })
          }
        />
        {idle && (
          <>
            <NumberField
              id="idle-timeout"
              label="Wait before prompting"
              unit="ms"
              min={3000}
              max={30000}
              value={idle.timeoutMs}
              onChange={(timeoutMs) => set({ idle: { ...idle, timeoutMs } })}
            />
            {idle.prompts.map((prompt, p) => (
              <div key={p} className="rt-card">
                <LinesEditor
                  label={`Idle prompt ${p + 1}`}
                  required
                  value={prompt}
                  onChange={(lines) =>
                    lines && setPrompts(idle.prompts.map((x, i) => (i === p ? lines : x)))
                  }
                />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setPrompts(idle.prompts.filter((_, i) => i !== p))}
                >
                  Remove idle prompt {p + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button"
              disabled={idle.prompts.length >= 2}
              onClick={() =>
                setPrompts([
                  ...idle.prompts,
                  { [language.default]: 'Please say something, or press a key.' },
                ])
              }
            >
              Add idle prompt
            </button>
          </>
        )}
      </SectionCard>
      <SectionCard
        title="Router limits"
        description="After either limit the router stops asking and uses the fallback."
      >
        <IssueList issues={index.bySection.limits} />
        <div className="rt-grid">
          <NumberField
            id="limit-turns"
            label="Most questions"
            min={1}
            max={20}
            value={draft.limits.maxTurns}
            onChange={(maxTurns) => set({ limits: { ...draft.limits, maxTurns } })}
          />
          <NumberField
            id="limit-seconds"
            label="Longest routing"
            unit="seconds"
            min={10}
            max={300}
            value={draft.limits.maxRouteSeconds}
            onChange={(maxRouteSeconds) => set({ limits: { ...draft.limits, maxRouteSeconds } })}
          />
        </div>
      </SectionCard>
      <SectionCard
        title="Agents"
        description="The router speaks for the point; the default agent is the last resort."
      >
        <IssueList issues={index.bySection.agents} />
        <div className="rt-grid">
          <AgentRefEditor
            id="router"
            label="Router agent"
            agents={agents}
            value={draft.router}
            onChange={(router) => set({ router })}
          />
          <AgentRefEditor
            id="default-target"
            label="Default agent"
            agents={agents}
            value={draft.defaultTarget}
            onChange={(defaultTarget) => set({ defaultTarget })}
          />
        </div>
      </SectionCard>
      <SectionCard
        title="Every line, audited"
        description="Each line needs text in the default language; other languages are optional."
      >
        <LinesTable rows={rows} fallbackLanguage={language.default} />
      </SectionCard>
    </fieldset>
  );
}
