'use client';
import type { DecisionEngine, LlmEngine } from '@winsendotai/ovo-contracts';
import {
  DecimalField,
  NumberField,
  SwitchField,
  TextAreaField,
} from '../../../components/routing/fields';

/** The decision engine and the language-model classifier: instructions, confidence threshold, timeout. */
export function ModelEngineEditor({
  engine,
  onChange,
  id,
}: {
  engine: DecisionEngine | LlmEngine;
  onChange: (engine: DecisionEngine | LlmEngine) => void;
  id: string;
}) {
  const isLlm = engine.kind === 'llm';
  return (
    <div className="rt-stack">
      <TextAreaField
        id={`${id}-instructions`}
        label="Instructions"
        value={engine.instructions}
        maxLength={isLlm ? 4000 : 2000}
        help={
          isLlm
            ? 'What the model decides. The branch descriptions below are its options; it never sees where they lead.'
            : 'The question the decision engine answers. The branch descriptions are its criteria.'
        }
        onChange={(instructions) => onChange({ ...engine, instructions })}
      />
      <DecimalField
        id={`${id}-threshold`}
        label="Confidence needed"
        value={engine.threshold}
        help="Below this the answer counts as low confidence and the next engine or the fallback runs. Model confidence is the model's own, not calibrated."
        onChange={(threshold) => onChange({ ...engine, threshold })}
      />
      <NumberField
        id={`${id}-timeout`}
        label="Give up after"
        unit="ms"
        min={isLlm ? 300 : 100}
        max={isLlm ? 8000 : 5000}
        value={engine.timeoutMs}
        onChange={(timeoutMs) => onChange({ ...engine, timeoutMs })}
      />
      {engine.kind === 'llm' && (
        <>
          <SwitchField
            label="Also detect the caller's language"
            checked={engine.detectLanguage}
            help="The model reports one of the allowed languages with its answer."
            onChange={(detectLanguage) => onChange({ ...engine, detectLanguage })}
          />
          <SwitchField
            label="Let the model ask its own clarifying question"
            checked={engine.generatedClarify}
            help="Off: the authored re-ask line is always used."
            onChange={(generatedClarify) => onChange({ ...engine, generatedClarify })}
          />
        </>
      )}
    </div>
  );
}
