'use client';
import type { QueueDefinition } from '../../lib/types/queues';
import { FormField } from '../../components/ui/form-field';
import { NumberField, FormSection, TextField } from '../../components/routing/fields';
import { HoldEditor } from '../../components/routing/hold-editor';
import type { AudioOption } from '../../components/routing/hold-steps';
import { HoursEditor } from '../../components/routing/hours-editor';
import { LinesEditor } from '../../components/routing/lines-editor';

export type Patch = (path: string, value: unknown) => void;

/** Name, hours, announcement and hold: what every queue has, whatever answers the call. */
export function CommonFields({
  draft,
  patch,
  errors,
  audio,
  creating,
}: {
  draft: QueueDefinition;
  patch: Patch;
  errors: Record<string, string | undefined>;
  audio: readonly AudioOption[];
  creating: boolean;
}) {
  return (
    <>
      <FormSection title="Queue">
        <TextField
          id="queue-name"
          label="Name"
          value={draft.name}
          required
          error={errors.name}
          onChange={(value) => patch('name', value)}
        />
        <FormField id="queue-description" label="Description" error={errors.description}>
          {(control) => (
            <textarea
              {...control}
              rows={2}
              maxLength={2000}
              value={draft.description ?? ''}
              onChange={(event) => patch('description', event.target.value || undefined)}
            />
          )}
        </FormField>
        {!creating && (
          <p className="muted">
            This is a {draft.kind === 'external' ? 'webhook queue' : 'operator desk queue'}. The
            type cannot change; create another queue instead.
          </p>
        )}
        <NumberField
          id="queue-max-waiting"
          label="Most callers waiting"
          min={1}
          max={500}
          help="A new caller is refused once this many are waiting or being offered."
          error={errors['limits.maxWaiting']}
          value={draft.limits.maxWaiting}
          onChange={(value) => patch('limits.maxWaiting', value)}
        />
      </FormSection>
      <FormSection title="Hours">
        <HoursEditor
          value={draft.hours}
          errors={errors}
          onChange={(value) => patch('hours', value)}
        />
      </FormSection>
      <FormSection
        title="What the caller hears"
        description="Said before the hold. Empty uses the routing point's line, else the built-in one."
      >
        <LinesEditor
          label="Announcement"
          value={draft.announcement}
          onChange={(value) => patch('announcement', value)}
        />
        <HoldEditor value={draft.hold} audio={audio} onChange={(value) => patch('hold', value)} />
      </FormSection>
    </>
  );
}
