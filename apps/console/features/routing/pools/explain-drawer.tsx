'use client';
import { useState } from 'react';
import { PoolConsiderationCard } from '../../../components/routing/pool-consideration';
import { SelectField, TagsField, TextField } from '../../../components/routing/fields';
import { Drawer } from '../../../components/ui/drawer';
import { ErrorState } from '../../../components/ui/feedback-v2';
import { routingApi } from '../../../lib/data/routing-api';
import { zonedToIso } from '../../../lib/derive/routing-simulate';
import type { PoolDefinition } from '../../../lib/derive/routing-pools';
import type { PoolExplanation } from '../../../lib/types/routing-simulate';

/** "Who would answer?": which members a call with these needs would reach, and why not the others. */
export function ExplainDrawer({ open, poolId, definition, onClose }: { open: boolean; poolId: string; definition: PoolDefinition; onClose: () => void }) {
  const languages = [...new Set(definition.members.flatMap((m) => m.languages))].sort();
  const [language, setLanguage] = useState('');
  const [mode, setMode] = useState<'caller' | 'any'>('caller');
  const [product, setProduct] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [at, setAt] = useState('');
  const [result, setResult] = useState<PoolExplanation>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const zone = definition.members.find((m) => m.hours)?.hours?.timezone ?? 'Asia/Kolkata';
  async function ask() {
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await routingApi.explain({
          poolId,
          target: { kind: 'pool', poolId, language: mode, ...(product ? { products: { values: [product] } } : {}), skills },
          context: { ...(language ? { language } : {}), ...(product ? { product } : {}) },
          ...(at ? { at: zonedToIso(at, zone) } : {}),
          load: 'empty',
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The question could not be answered.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer open={open} title="Who would answer?" onClose={onClose}>
      <div className="queue-form">
        <SelectField id="explain-language" label="Caller's language" value={language} placeholder="Not known" options={languages.map((l) => ({ value: l, label: l }))} onChange={setLanguage} />
        <SelectField id="explain-mode" label="Agent language" value={mode} options={[{ value: 'caller', label: "Must speak the caller's language" }, { value: 'any', label: 'Any language' }]} onChange={(v) => setMode(v as 'caller' | 'any')} />
        <TextField id="explain-product" label="Product" value={product} onChange={setProduct} help="Optional." />
        <TagsField id="explain-skills" label="Skills needed" values={skills} onChange={setSkills} />
        <label className="field">
          <span>When ({zone})</span>
          <input type="datetime-local" aria-label="When" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <div className="button-row">
          <button type="button" className="button primary" disabled={busy} onClick={() => void ask()}>{busy ? 'Checking…' : 'Check'}</button>
        </div>
        {error && <ErrorState message={error} onRetry={() => void ask()} />}
        {result && <PoolConsiderationCard pool={result} />}
      </div>
    </Drawer>
  );
}
