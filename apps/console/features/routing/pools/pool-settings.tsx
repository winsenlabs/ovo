'use client';
import { TagsField, TextAreaField, TextField } from '../../../components/routing/fields';
import { SectionCard } from '../../../components/ui/section-card';
import type { PoolDefinition } from '../../../lib/derive/routing-pools';

/** Name, description, the fallback languages and who uses the pool. */
export function PoolSettings({
  definition,
  canEdit,
  usedBy,
  onChange,
}: {
  definition: PoolDefinition;
  canEdit: boolean;
  usedBy: string[];
  onChange: (change: (current: PoolDefinition) => PoolDefinition) => void;
}) {
  return (
    <SectionCard title="Pool settings">
      <fieldset className="rt-readonly rt-stack" disabled={!canEdit}>
        <TextField id="pool-name" label="Name" value={definition.name} onChange={(name) => onChange((d) => ({ ...d, name }))} />
        <TextAreaField id="pool-description" label="Description" rows={2} value={definition.description ?? ''} onChange={(description) => onChange((d) => ({ ...d, description: description || undefined }))} />
        <TagsField id="pool-fallback" label="If nobody speaks the caller's language, try" values={definition.languageFallback} placeholder="en" help="Languages in order, up to 5." onChange={(languageFallback) => onChange((d) => ({ ...d, languageFallback }))} />
        <p className="muted">{usedBy.length ? `Used by ${usedBy.join(', ')}.` : 'No routing point names this pool yet.'}</p>
      </fieldset>
    </SectionCard>
  );
}
