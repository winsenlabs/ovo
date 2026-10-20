'use client';
import { isRoutingKey } from '../../../lib/derive/routing-draft-edit';
import type { TransferTarget } from '@winsendotai/ovo-contracts';
import { useEffect, useState } from 'react';
import { LinesEditor } from '../../../components/routing/lines-editor';
import { HoldEditor } from '../../../components/routing/hold-editor';
import { SelectField, TextAreaField, TextField } from '../../../components/routing/fields';
import { Drawer } from '../../../components/ui/drawer';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { useDesigner } from './designer-context';
import { DestinationEditor, SourcesEditor } from './transfer-destination';

/** One transfer target: what the transferring agent's model reads, where it goes, who may use it, how it holds. */
export function TargetDrawer({
  target,
  isNew = false,
  existingKeys,
  onSave,
  onClose,
}: {
  target: TransferTarget | undefined;
  isNew?: boolean;
  existingKeys: readonly string[];
  onSave: (target: TransferTarget) => void;
  onClose: () => void;
}) {
  const { audio, draft } = useDesigner();
  const [value, setValue] = useState<TransferTarget>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    setValue(target && structuredClone(target));
    setProblem(undefined);
  }, [target]);
  if (!value)
    return (
      <Drawer open={false} title="Transfer target" onClose={onClose}>
        {null}
      </Drawer>
    );
  const set = (patch: Partial<TransferTarget>) => setValue({ ...value, ...patch });
  const save = () => {
    if (!isRoutingKey(value.key))
      return setProblem('The key is lowercase letters, digits, - or _, starting with a letter.');
    if (existingKeys.includes(value.key))
      return setProblem(`A target called ${value.key} already exists.`);
    onSave(value);
  };
  const queueKeys = (draft.humanQueues ?? []).map((b) => b.key);
  return (
    <Drawer
      open
      title={isNew ? 'New transfer target' : `Transfer target ${target?.key ?? ''}`}
      onClose={onClose}
    >
      <div className="queue-form">
        {problem && <InlineAlert tone="danger">{problem}</InlineAlert>}
        <TextField
          id="target-key"
          label="Key"
          mono
          value={value.key}
          help="The name the transferring agent chooses by."
          onChange={(key) => set({ key })}
        />
        <TextAreaField
          id="target-description"
          label="When to use it"
          rows={2}
          value={value.description}
          help="The agent's model reads this to decide; it never sees the destination."
          onChange={(description) => set({ description })}
        />
        <LinesEditor
          label="Name said to the caller (optional)"
          value={value.label}
          onChange={(label) => set({ label })}
        />
        <DestinationEditor
          id="target-destination"
          value={value.destination}
          onChange={(destination) => set({ destination })}
        />
        <SourcesEditor id="target-sources" value={value.from} onChange={(from) => set({ from })} />
        <LinesEditor
          label="Announcement before transferring (optional)"
          value={value.announcement}
          onChange={(announcement) => set({ announcement })}
        />
        <SelectField
          id="target-confirm"
          label="Ask the caller first"
          value={value.confirm ?? ''}
          options={[
            { value: '', label: "Use the point's setting" },
            { value: 'never', label: 'Never ask' },
            { value: 'ask', label: 'Ask "shall I transfer you?"' },
          ]}
          onChange={(confirm) =>
            set({ confirm: (confirm || undefined) as TransferTarget['confirm'] })
          }
        />
        <HoldEditor
          idPrefix="target-hold"
          value={value.hold}
          waitForCapacity
          audio={audio.map((a) => ({ value: a.id, label: a.name }))}
          choices={{ queues: queueKeys, targets: existingKeys.filter((k) => k !== value.key) }}
          offHelp="Off: the point's hold applies to this target."
          onChange={(hold) => set({ hold })}
        />
        <div className="button-row queue-form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={save}>
            Save target
          </button>
        </div>
      </div>
    </Drawer>
  );
}
