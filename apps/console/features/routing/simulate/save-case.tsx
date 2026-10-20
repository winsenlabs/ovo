'use client';
import { useMemo, useState } from 'react';
import { SelectField, SwitchField, TextField } from '../../../components/routing/fields';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { SectionCard } from '../../../components/ui/section-card';
import { buildEvalCase, evalCaseJsonl, type SimForm } from '../../../lib/derive/routing-simulate';
import type { RoutingEvalCaseJson, RoutingSimulationResult } from '../../../lib/types/routing-simulate';

type Expect = RoutingEvalCaseJson['expect'];
const FIELDS: { key: keyof Expect; label: string }[] = [
  { key: 'status', label: 'Ends with' },
  { key: 'path', label: 'Questions visited (comma separated)' },
  { key: 'node', label: 'Last question' },
  { key: 'pool', label: 'Pool' },
  { key: 'member', label: 'Member' },
  { key: 'agentId', label: 'Agent' },
  { key: 'language', label: 'Language' },
  { key: 'fallback', label: 'Deepest fallback' },
  { key: 'clarify', label: 'Asked again' },
];

/** Turn this run into an eval case: what happened becomes what the case expects, field by field. */
export function SaveAsCase({ form, result, timeZone }: { form: SimForm; result: RoutingSimulationResult; timeZone?: string }) {
  const base = useMemo(() => buildEvalCase(form, result, 'case-1', { timeZone }), [form, result, timeZone]);
  const [id, setId] = useState('case-1');
  const [description, setDescription] = useState('');
  const [expect, setExpect] = useState<Expect>(base.expect);
  const [notice, setNotice] = useState<string>();
  const idOk = /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(id);
  const kept = (Object.keys(expect) as (keyof Expect)[]).length;
  const final: RoutingEvalCaseJson = { ...base, id, ...(description ? { description } : {}), expect };
  const toggle = (key: keyof Expect, on: boolean) => {
    const next = { ...expect };
    if (on) (next as Record<string, unknown>)[key] = base.expect[key] ?? (key === 'clarify' ? false : '');
    else delete next[key];
    setExpect(next);
  };
  const setValue = (key: keyof Expect, value: string | boolean) => setExpect({ ...expect, [key]: key === 'path' && typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(final, null, 2));
      setNotice('Copied the case as JSON.');
    } catch {
      setNotice('Copying is not available here. Download the file instead.');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([evalCaseJsonl([final])], { type: 'application/x-ndjson' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `${id || 'case'}.jsonl` });
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <SectionCard title="Save as an eval case" description="A case replays this script and checks the route still ends the same way. Use made-up callers, not real ones.">
      <div className="rt-stack">
        <TextField id="case-id" label="Case id" mono value={id} error={idOk ? undefined : 'Lowercase letters, digits, . _ -'} onChange={setId} />
        <TextField id="case-description" label="Description (optional)" value={description} onChange={setDescription} />
        <fieldset className="queue-section">
          <legend>What the case checks</legend>
          {FIELDS.filter((f) => base.expect[f.key] !== undefined).map((f) => {
            const on = f.key in expect;
            const value = expect[f.key];
            return (
              <div key={f.key} className="rt-expect">
                <SwitchField label={f.label} checked={on} onChange={(next) => toggle(f.key, next)} />
                {on && f.key === 'clarify' && <SwitchField label="It asks the caller again" checked={Boolean(value)} onChange={(v) => setValue(f.key, v)} />}
                {on && f.key === 'fallback' && (
                  <SelectField id="expect-fallback" label="Deepest fallback" value={String(value)} options={['none', 'default', 'human', 'callback', 'end', 'limit', 'release_default'].map((v) => ({ value: v, label: v }))} onChange={(v) => setValue(f.key, v)} />
                )}
                {on && f.key !== 'clarify' && f.key !== 'fallback' && (
                  <TextField id={`expect-${f.key}`} label={f.label} value={Array.isArray(value) ? value.join(', ') : String(value ?? '')} onChange={(v) => setValue(f.key, v)} />
                )}
              </div>
            );
          })}
        </fieldset>
        {kept === 0 && <InlineAlert tone="warn">A case must check at least one thing.</InlineAlert>}
        {notice && <InlineAlert tone="info">{notice}</InlineAlert>}
        <div className="button-row">
          <button type="button" className="button" disabled={!idOk || kept === 0} onClick={() => void copy()}>Copy as JSON</button>
          <button type="button" className="button" disabled={!idOk || kept === 0} onClick={download}>Download as JSONL</button>
        </div>
      </div>
    </SectionCard>
  );
}
