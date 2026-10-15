'use client';
// Wires each disabled choice's reason to its radio via `aria-describedby` (console-primitives.test.tsx
// locks this down: a screen-reader user must be able to reach *why* a plugin is disabled).
// `RadioCardGroup` renders the reason only as the card's `title` tooltip, with no id to point to
// — rather than re-implement its markup (and duplicate it, per the lint duplication gate), this
// patches the two attributes onto its rendered DOM after each render. Foundation request: give
// `RadioCardGroup` this wiring natively so this wrapper can be deleted.
import { useEffect, useRef } from 'react';
import { RadioCardGroup } from '../ui/choice-card';

type Props = Parameters<typeof RadioCardGroup>[0];

export function SlotChoiceCardGroup(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cards = container.current?.querySelectorAll<HTMLElement>('.ds-choice-card') ?? [];
    cards.forEach((card, index) => {
      const choice = props.choices[index];
      const radio = card.querySelector<HTMLInputElement>('input[type=radio]');
      const reason = card.querySelector<HTMLElement>('.ds-choice-disabled-reason');
      if (!radio || !reason || !choice?.disabledReason) return;
      const id = `${props.name}-${choice.value}-reason`;
      reason.id = id;
      radio.setAttribute('aria-describedby', id);
    });
  }, [props.choices, props.name]);
  return (
    <div ref={container}>
      <RadioCardGroup {...props} />
    </div>
  );
}
