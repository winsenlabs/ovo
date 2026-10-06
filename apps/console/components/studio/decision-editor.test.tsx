import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfig as AgentConfigSchema } from '@winsendotai/ovo-contracts';
import { emptyAgentConfig, type AgentConfig } from '../../lib/api';
import { DecisionEditor } from './decision-editor';

afterEach(() => cleanup());

const base = (decision?: AgentConfig['decision']): AgentConfig => ({
  ...emptyAgentConfig(),
  mode: 'agent',
  ...(decision ? { decision } : {}),
});

const policy = (): NonNullable<AgentConfig['decision']> => ({
  enabled: true,
  timeoutMs: 1500,
  state: { sources: ['last-turn'], transcriptTurns: 6 },
  questions: [
    {
      type: 'choice',
      id: 'intent',
      purpose: '',
      instructions: 'What does the caller want?',
      threshold: 0.8,
      fallback: 'llm',
      options: [
        { key: 'pay', description: 'Wants to pay', outcome: { say: 'Sending a link.' } },
        { key: 'other', description: 'Anything else', outcome: {} },
      ],
    },
  ],
});

function harness(initial: AgentConfig) {
  let current = initial;
  function Harness() {
    const [config, setConfig] = useState<AgentConfig>(initial);
    return (
      <DecisionEditor
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

describe('authoring a decision from the console', () => {
  it('starts from nothing and produces a config the shared contract accepts', () => {
    const latest = harness(base());
    fireEvent.click(screen.getByRole('button', { name: 'Add a decision question' }));
    const config = latest();
    expect(config.decision?.enabled).toBe(true);
    expect(config.decision?.questions).toHaveLength(1);
    // The seeded shape must be valid on its own, or the first save fails on an untouched draft.
    expect(() => AgentConfigSchema.parse(config)).not.toThrow();
  });

  it('removing the last question removes the policy, not just its contents', () => {
    const latest = harness(base(policy()));
    fireEvent.click(screen.getByRole('button', { name: 'Remove question' }));
    // An agent policy with neither questions nor a flow is refused at release, so it must go.
    expect(latest().decision).toBeUndefined();
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('refuses to leave a decision grounded in nothing without saying so', () => {
    harness(base(policy()));
    fireEvent.click(screen.getByLabelText('Last caller turn'));
    expect(screen.getByText(/grounded in nothing is a guess/)).not.toBeNull();
  });

  it('only offers the transcript depth once the transcript is a source', () => {
    harness(base(policy()));
    expect(screen.queryByLabelText('Transcript turns')).toBeNull();
    fireEvent.click(screen.getByLabelText('Transcript'));
    expect(screen.getByLabelText('Transcript turns')).not.toBeNull();
  });

  it('keeps the threshold, the expectation and the spoken line apart from the model text', () => {
    const latest = harness(base(policy()));
    fireEvent.change(screen.getByLabelText('Use the answer at or above'), {
      target: { value: '0.95' },
    });
    fireEvent.change(screen.getByLabelText('The answer you expect'), { target: { value: 'pay' } });
    const question = latest().decision!.questions[0]!;
    expect(question.threshold).toBe(0.95);
    expect(question.type === 'choice' && question.expected).toBe('pay');
    // The description is what the model reads; it is untouched by either edit.
    expect(question.type === 'choice' && question.options[0]!.description).toBe('Wants to pay');
  });

  it('clears a spoken outcome to nothing rather than to an empty string', () => {
    const latest = harness(base(policy()));
    fireEvent.change(screen.getAllByLabelText('Then say')[0]!, { target: { value: '   ' } });
    const question = latest().decision!.questions[0]!;
    expect(question.type === 'choice' && question.options[0]!.outcome).toEqual({});
    // An empty `say` would fail the contract's min length; absence is what "let the LLM reply" is.
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('switching shape produces a complete question of the new shape', () => {
    const latest = harness(base(policy()));
    fireEvent.change(screen.getByLabelText('Answer shape'), { target: { value: 'score' } });
    const question = latest().decision!.questions[0]!;
    expect(question.type).toBe('score');
    expect(question.type === 'score' && question.bands.some((band) => band.atLeast === 0)).toBe(
      true,
    );
    expect(question.instructions).toBe('What does the caller want?');
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();

    fireEvent.change(screen.getByLabelText('Answer shape'), { target: { value: 'noul' } });
    expect(latest().decision!.questions[0]!.type).toBe('noul');
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('will not let the last two choice options be removed', () => {
    harness(base(policy()));
    expect(screen.queryByRole('button', { name: 'Remove option' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    expect(screen.getAllByRole('button', { name: 'Remove option' })).toHaveLength(3);
  });

  it('drops an expectation that pointed at a removed option', () => {
    const latest = harness(base(policy()));
    fireEvent.change(screen.getByLabelText('The answer you expect'), { target: { value: 'pay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    const options = screen.getAllByRole('group', { name: /^Option / });
    fireEvent.click(within(options[0]!).getByRole('button', { name: 'Remove option' }));
    const question = latest().decision!.questions[0]!;
    expect(question.type === 'choice' && question.expected).toBeUndefined();
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('adds a second question that costs no extra round trip, with a distinct id', () => {
    const latest = harness(base(policy()));
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    const ids = latest().decision!.questions.map((question) => question.id);
    expect(new Set(ids).size).toBe(2);
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('disabling the policy keeps the authored questions', () => {
    const latest = harness(base(policy()));
    fireEvent.click(screen.getByLabelText('Run decisions on this agent'));
    expect(latest().decision?.enabled).toBe(false);
    expect(latest().decision?.questions).toHaveLength(1);
  });
});
