import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfig as AgentConfigSchema } from '@winsendotai/ovo-contracts';
import { emptyAgentConfig, type AgentConfig } from '../../lib/api';
import { KnowledgeEditor } from './knowledge-editor';

afterEach(() => cleanup());

const base = (knowledge?: AgentConfig['knowledge']): AgentConfig => ({
  ...emptyAgentConfig(),
  mode: 'agent',
  ...(knowledge ? { knowledge } : {}),
});

const policy = (): NonNullable<AgentConfig['knowledge']> => ({
  enabled: true,
  sourceIds: ['collections'],
  topK: 4,
  minScore: 0.4,
  maxCharacters: 4000,
  timeoutMs: 1000,
  requireGrounding: false,
});

function harness(initial: AgentConfig) {
  let current = initial;
  function Harness() {
    const [config, setConfig] = useState<AgentConfig>(initial);
    return (
      <KnowledgeEditor
        config={config}
        update={(next) => {
          current = next;
          setConfig(next);
        }}
      />
    );
  }
  render(<Harness />);
  return () => current;
}

describe('authoring grounding from the console', () => {
  it('starts from nothing and produces a config the shared contract accepts', () => {
    const latest = harness(base());
    fireEvent.click(screen.getByRole('button', { name: 'Ground this agent' }));
    const config = latest();
    expect(config.knowledge?.enabled).toBe(true);
    // The threshold has no contract default, so the seed must supply one or the first save fails.
    expect(config.knowledge?.minScore).toBe(0.4);
    expect(() => AgentConfigSchema.parse(config)).not.toThrow();
  });

  it('removes the policy entirely rather than leaving a disabled husk', () => {
    const latest = harness(base(policy()));
    fireEvent.click(screen.getByRole('button', { name: 'Remove grounding' }));
    expect(latest().knowledge).toBeUndefined();
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('edits the threshold and the budget without touching the sources', () => {
    const latest = harness(base(policy()));
    fireEvent.change(screen.getByLabelText('Use a passage at or above'), {
      target: { value: '0.65' },
    });
    fireEvent.change(screen.getByLabelText('Characters of retrieved text per turn'), {
      target: { value: '8000' },
    });
    expect(latest().knowledge).toMatchObject({
      minScore: 0.65,
      maxCharacters: 8000,
      sourceIds: ['collections'],
    });
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('warns before every ungrounded turn starts refusing', () => {
    harness(base(policy()));
    expect(screen.queryByText(/will answer with the uncertainty line/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Refuse rather than answer ungrounded'));
    expect(screen.getByText(/will answer with the uncertainty line/)).not.toBeNull();
  });

  it('treats an emptied source list as every source, not as none', () => {
    const latest = harness(base(policy()));
    const sources = screen.getByLabelText('Sources this agent may read (one per line)');
    fireEvent.change(sources, { target: { value: '' } });
    fireEvent.blur(sources);
    expect(latest().knowledge?.sourceIds).toEqual([]);
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('keeps the policy when retrieval is switched off', () => {
    const latest = harness(base(policy()));
    fireEvent.click(screen.getByLabelText('Retrieve on every turn'));
    expect(latest().knowledge?.enabled).toBe(false);
    expect(latest().knowledge?.sourceIds).toEqual(['collections']);
  });
});
