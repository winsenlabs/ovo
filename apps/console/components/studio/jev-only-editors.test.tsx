import { useState, type ComponentType } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfig as AgentConfigSchema } from '@winsendotai/ovo-contracts';
import { emptyAgentConfig, type AgentConfig } from '../../lib/api';
import { IdleEditor } from './idle-editor';
import { JevOnlyPanel } from './jev-only-panel';
import { RecoveryEditor } from './recovery-editor';
import { RulesEditor } from './rules-editor';

afterEach(() => cleanup());

type Editor = ComponentType<{ config: AgentConfig; update: (next: AgentConfig) => void }>;

const decision = (): NonNullable<AgentConfig['decision']> => ({
  enabled: true,
  questions: [
    {
      type: 'choice',
      id: 'intent',
      purpose: '',
      instructions: 'What does the caller want?',
      threshold: 0.7,
      fallback: 'clarify',
      options: [
        { key: 'pay', description: 'Will pay', outcome: { say: 'Thank you.' } },
        { key: 'bye', description: 'Goodbye', outcome: { say: 'Goodbye.', end: true } },
      ],
    },
  ],
  state: { sources: ['last-turn'], transcriptTurns: 6 },
  timeoutMs: 800,
});
const base = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  ...emptyAgentConfig(),
  mode: 'agent',
  ...over,
});

function harness(Editor: Editor, initial: AgentConfig) {
  let current = initial;
  function Harness() {
    const [config, setConfig] = useState<AgentConfig>(initial);
    return (
      <Editor
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
const valid = (config: AgentConfig) => expect(() => AgentConfigSchema.parse(config)).not.toThrow();

describe('caller silence editor (AGT-11)', () => {
  it('seeds escalating prompts and a closing line the contract accepts, then removes them', () => {
    const latest = harness(IdleEditor, base());
    fireEvent.click(screen.getByRole('button', { name: 'Add silence prompts' }));
    expect(latest().idle).toMatchObject({ timeoutMs: 8000, prompts: ['Hello? Can you hear me?'] });
    valid(latest());
    fireEvent.change(screen.getByLabelText('Silence before a prompt (seconds)'), {
      target: { value: '6' },
    });
    const prompts = screen.getByLabelText('Prompts, one per silence (one per line)');
    fireEvent.change(prompts, { target: { value: 'Hello?\n\nAre you there, sir, or not?' } });
    fireEvent.blur(prompts);
    expect(latest().idle).toMatchObject({
      timeoutMs: 6000,
      prompts: ['Hello?', 'Are you there, sir, or not?'],
    });
    valid(latest());
    fireEvent.click(screen.getByRole('button', { name: 'Remove silence prompts' }));
    expect(latest().idle).toBeUndefined();
  });
});

describe('recovery editor (AGT-12)', () => {
  it('adds the defaults, a per-question re-ask and repeat, all valid', () => {
    const latest = harness(RecoveryEditor, base({ decision: decision() }));
    fireEvent.click(screen.getByRole('button', { name: 'Add recovery lines' }));
    valid(latest());
    fireEvent.change(screen.getByLabelText('Re-ask for intent'), {
      target: { value: 'When can you pay?' },
    });
    fireEvent.click(screen.getByLabelText(/Repeat the last line on request/));
    fireEvent.change(screen.getByLabelText('Misses in a row before giving up'), {
      target: { value: '3' },
    });
    expect(latest().recovery).toMatchObject({
      reprompts: { intent: 'When can you pay?' },
      repeat: { prefix: 'Sure, let me repeat that.', phrases: [] },
      maxAttempts: 3,
    });
    valid(latest());
    // Clearing a re-ask removes it rather than saving an empty line the contract would refuse.
    fireEvent.change(screen.getByLabelText('Re-ask for intent'), { target: { value: '' } });
    expect(latest().recovery?.reprompts).toEqual({});
    fireEvent.change(screen.getByLabelText('Then'), { target: { value: 'llm' } });
    expect(screen.queryByLabelText('Give-up line')).toBeNull();
    valid(latest());
  });
});

describe('Jev-only panel (AGT-4)', () => {
  it('lists the paths that still reach the LLM until each is answered', () => {
    const latest = harness(JevOnlyPanel, base({ decision: decision() }));
    expect(screen.getByText('LLM on 1 path')).toBeTruthy();
    expect(screen.getByText(/falls through to the LLM/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Answer an unavailable decision model/));
    expect(screen.getByText('Jev-only')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Then'), { target: { value: 'end' } });
    expect(screen.getByRole('alert').textContent).toMatch(/needs the line/);
    fireEvent.change(screen.getByLabelText('Line when the decision is unavailable'), {
      target: { value: 'We will call you back.' },
    });
    expect(latest().decisionUnavailable).toEqual({
      action: 'end',
      line: 'We will call you back.',
    });
    valid(latest());
  });

  it('explains that an agent with no decision policy needs its LLM', () => {
    harness(JevOnlyPanel, base());
    expect(screen.getByText(/every turn goes to the LLM/)).toBeTruthy();
    expect(screen.queryByLabelText(/Answer an unavailable decision model/)).toBeNull();
  });
});

describe('instant rules editor (AGT-6)', () => {
  it('needs a decision question to answer', () => {
    harness(RulesEditor, base());
    expect(screen.getByText('Needs a decision question')).toBeTruthy();
  });

  it('authors a rule against a decision answer and flags an unsafe pattern', () => {
    const latest = harness(RulesEditor, base({ decision: decision() }));
    fireEvent.click(screen.getByRole('button', { name: 'Add instant rules' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    fireEvent.change(screen.getByLabelText('Answers'), { target: { value: 'intent=bye' } });
    fireEvent.click(screen.getByLabelText('bye'));
    const phrases = screen.getByLabelText('Exact replies (one per line)');
    fireEvent.change(phrases, { target: { value: "That's all, thanks" } });
    fireEvent.blur(phrases);
    expect(latest().rules?.global).toEqual([
      {
        intent: 'intent=bye',
        phrases: ["That's all, thanks"],
        keywords: [],
        patterns: [],
        lexicons: ['yes', 'bye'],
        maxWords: 4,
      },
    ]);
    valid(latest());
    const patterns = screen.getByLabelText('Patterns (one per line)');
    fireEvent.change(patterns, { target: { value: '(a+)+' } });
    fireEvent.blur(patterns);
    expect(screen.getByText(/repeats a group that itself repeats/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(latest().rules?.global).toEqual([]);
  });
});
