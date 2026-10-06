import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfig as AgentConfigSchema, inspectFlow } from '@winsendotai/ovo-contracts';
import { emptyAgentConfig, type AgentConfig } from '../../lib/api';
import { DecisionEditor } from './decision-editor';

afterEach(() => cleanup());

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

const agent = (): AgentConfig => ({ ...emptyAgentConfig(), mode: 'agent' });
const startFlow = () => {
  const latest = harness(agent());
  fireEvent.click(screen.getByRole('button', { name: 'Start a conversation flow' }));
  return latest;
};
const flowOf = (config: AgentConfig) => config.decision!.flow!;

const poc = {
  start: 'greet',
  lines: { ask: 'Am I speaking with {{full_name}}?', bye: 'Goodbye.' },
  nodes: [
    { id: 'greet', say: ['ask'], listen: 'identity' },
    { id: 'bye', say: ['bye'], end: true, disposition: 'wrong_number' },
  ],
  listens: [
    {
      id: 'identity',
      question: 'Who picked up?',
      intents: [{ key: 'wrong_person', description: 'Wrong number', next: 'bye' }],
    },
  ],
};

describe('authoring a conversation flow (AGT-1)', () => {
  it('starts a flow that the shared contract and the release check both accept', () => {
    const config = startFlow()();
    expect(() => AgentConfigSchema.parse(config)).not.toThrow();
    expect(inspectFlow(flowOf(config))).toEqual([]);
    expect(config.decision?.questions).toEqual([]);
    expect(screen.getByText('2-state flow')).not.toBeNull();
  });

  it('imports a conversation map as JSON and shows where every intent leads', () => {
    const latest = startFlow();
    fireEvent.click(screen.getByText('Flow JSON (import or edit the whole map)'));
    fireEvent.change(screen.getByLabelText('Flow JSON'), {
      target: { value: JSON.stringify(poc) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and replace flow' }));
    expect(flowOf(latest()).nodes.map((node) => node.id)).toEqual(['greet', 'bye']);
    expect(screen.getByText('→ bye')).not.toBeNull();
    expect(screen.getByText('wrong_number')).not.toBeNull();
    expect(screen.getByText('Rendered per call')).not.toBeNull();
  });

  it('refuses JSON that is not a flow, and says where', () => {
    const latest = startFlow();
    fireEvent.click(screen.getByText('Flow JSON (import or edit the whole map)'));
    fireEvent.change(screen.getByLabelText('Flow JSON'), { target: { value: '{"start": 3}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and replace flow' }));
    expect(screen.getByText(/^start:/)).not.toBeNull();
    expect(flowOf(latest()).start).toBe('greet');
    fireEvent.change(screen.getByLabelText('Flow JSON'), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and replace flow' }));
    expect(screen.getByText('Enter valid JSON.')).not.toBeNull();
  });

  it('shows graph errors live, as the release check will block them', () => {
    startFlow();
    fireEvent.click(screen.getByText('Flow JSON (import or edit the whole map)'));
    const broken = { ...poc, nodes: [...poc.nodes, { id: 'orphan', say: ['bye'], end: true }] };
    fireEvent.change(screen.getByLabelText('Flow JSON'), {
      target: { value: JSON.stringify(broken) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and replace flow' }));
    expect(screen.getByRole('alert').textContent).toContain('1 issue blocks a release');
    expect(screen.getByRole('alert').textContent).toContain(
      'Error at nodes.2: Node orphan cannot be reached from greet',
    );
  });

  it('edits line wording in place, never saving an empty line', () => {
    const latest = startFlow();
    const field = screen.getByLabelText('greeting');
    fireEvent.change(field, { target: { value: 'Namaste, {{name}}.' } });
    expect(flowOf(latest()).lines.greeting).toBe('Namaste, {{name}}.');
    fireEvent.change(field, { target: { value: '  ' } });
    expect(flowOf(latest()).lines.greeting).toBe('Namaste, {{name}}.');
    expect(screen.getByText('A line cannot be empty.')).not.toBeNull();
  });

  it('switches to a flow that never reaches the LLM', () => {
    const latest = startFlow();
    fireEvent.change(screen.getByLabelText('A reply that fits nothing'), {
      target: { value: 'clarify' },
    });
    fireEvent.change(screen.getByLabelText('Asking again'), { target: { value: 'greeting' } });
    expect(flowOf(latest())).toMatchObject({ fallback: 'clarify', clarify: 'greeting' });
    fireEvent.change(screen.getByLabelText('Asking again'), { target: { value: '' } });
    expect(flowOf(latest())).not.toHaveProperty('clarify');
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
  });

  it('removes the whole policy with the flow', () => {
    const latest = startFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Remove flow' }));
    expect(latest().decision).toBeUndefined();
  });
});

describe('decisions in a script (AGT-14)', () => {
  const scripted = (): AgentConfig => ({
    ...emptyAgentConfig(),
    mode: 'announcement',
    script: {
      start: 'ask',
      maxVisits: 20,
      nodes: [
        {
          id: 'ask',
          prompt: 'Pay now?',
          terminal: false,
          transitions: [{ event: 'text', matches: ['yes'], to: 'done' }],
        },
        { id: 'done', prompt: 'Thanks.', terminal: true, transitions: [] },
      ],
    },
  });

  it('offers only reply matching, which the release check accepts for a script', () => {
    const latest = harness(scripted());
    expect(screen.queryByRole('button', { name: 'Add a decision question' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Match replies with the decision model' }));
    expect(latest().decision).toMatchObject({ enabled: true, questions: [] });
    expect(latest().decision).not.toHaveProperty('flow');
    expect(() => AgentConfigSchema.parse(latest())).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: 'Stop matching with the decision model' }));
    expect(latest().decision).toBeUndefined();
  });
});
