'use client';
import { useState } from 'react';
import { RadioCardGroup } from '../../../components/ui/choice-card';

/** Split out of the design-system page only to keep that module under the size gate. */
export function ChoiceCardDemo() {
  const [mode, setMode] = useState('faq');
  return (
    <RadioCardGroup
      name="mode-demo"
      value={mode}
      onChange={setMode}
      choices={[
        { value: 'announcement', title: 'Announcement', description: 'No LLM', chips: ['No LLM'] },
        { value: 'faq', title: 'FAQ', description: 'Deterministic matching', chips: ['No LLM'] },
        { value: 'agent', title: 'Agent', description: 'LLM + tools', chips: ['LLM', 'Tools'] },
        {
          value: 'context',
          title: 'Context',
          description: 'Bounded supplied context',
          disabled: true,
          disabledReason: 'Requires a knowledge source',
        },
      ]}
    />
  );
}
