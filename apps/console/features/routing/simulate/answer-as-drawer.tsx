'use client';
import { useEffect, useState } from 'react';
import { DecimalField, SelectField } from '../../../components/routing/fields';
import { Drawer } from '../../../components/ui/drawer';
import type { SimulatedAnswer, SimulatedEngine } from '../../../lib/types/routing-simulate';

/** Script an answer for an engine the run asked about, then run again. */
export function AnswerAsDrawer({
  target,
  branches,
  onClose,
  onSubmit,
}: {
  target: { node: string; engine: SimulatedEngine } | undefined;
  branches: readonly string[];
  onClose: () => void;
  onSubmit: (answer: SimulatedAnswer) => void;
}) {
  const [branch, setBranch] = useState('');
  const [confidence, setConfidence] = useState(0.9);
  useEffect(() => {
    setBranch(branches[0] ?? '');
    setConfidence(0.9);
  }, [target, branches]);
  return (
    <Drawer
      open={target !== undefined}
      title={`Answer as ${target?.engine ?? 'the engine'} on ${target?.node ?? ''}`}
      onClose={onClose}
    >
      <div className="queue-form">
        <SelectField
          id="answer-as-branch"
          label="Choose branch"
          value={branch}
          options={branches.map((b) => ({ value: b, label: b }))}
          onChange={setBranch}
        />
        <DecimalField
          id="answer-as-confidence"
          label="Confidence"
          value={confidence}
          onChange={setConfidence}
        />
        <div className="button-row queue-form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!branch || !target}
            onClick={() =>
              target &&
              onSubmit({
                node: target.node,
                engine: target.engine,
                branch,
                confidence,
                repeat: false,
              })
            }
          >
            Answer and run again
          </button>
        </div>
      </div>
    </Drawer>
  );
}
