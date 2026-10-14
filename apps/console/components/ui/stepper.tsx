export type StepState = 'done' | 'current' | 'upcoming';

/** Numbered step indicator. Fixes the overlapping "1. 1 · Basic2. 2 · Plugin…" wizard defect. */
export function Stepper({ steps }: { steps: readonly { label: string; state: StepState }[] }) {
  return (
    <ol className="ds-stepper" aria-label="Progress">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={`state-${step.state}`}
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          <span className="ds-stepper-dot" aria-hidden="true">
            {step.state === 'done' ? '✓' : index + 1}
          </span>
          <span className="ds-stepper-label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
