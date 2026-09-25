import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAgentConfig, type AgentConfig } from '../../lib/api';
import { ScriptEditor, diagnoseScript } from './script-editor';
import { editScriptNode } from './script-graph';

const script = (): NonNullable<AgentConfig['script']> => ({
  start: 'start',
  maxVisits: 20,
  nodes: [
    {
      id: 'start',
      prompt: 'Begin',
      terminal: false,
      transitions: [
        { event: 'text', matches: ['yes'], to: 'done' },
        { event: 'text', matches: ['again'], to: 'retry' },
      ],
    },
    { id: 'done', prompt: 'Finished', terminal: true, transitions: [] },
    {
      id: 'retry',
      prompt: 'Try again',
      terminal: false,
      transitions: [{ event: 'text', matches: ['restart'], to: 'start' }],
    },
  ],
});

afterEach(() => cleanup());

describe('script reference integrity', () => {
  it('refuses a duplicate ID and keeps unrelated edges when a later unique ID commits', () => {
    const updates = vi.fn();
    let current = { ...emptyAgentConfig(), script: script() };
    function Harness() {
      const [config, setConfig] = useState<AgentConfig>(current);
      return (
        <ScriptEditor
          config={config}
          update={(next) => {
            current = next as typeof current;
            updates(next);
            setConfig(next);
          }}
        />
      );
    }
    render(<Harness />);
    const id = screen.getByRole('textbox', { name: 'Node 3 ID' });
    fireEvent.change(id, { target: { value: 'done' } });
    expect(updates).not.toHaveBeenCalled();
    fireEvent.blur(id);
    expect(screen.getByRole('alert').textContent).toContain('Node ID done already exists.');
    expect(current.script.nodes.map((node) => node.id)).toEqual(['start', 'done', 'retry']);
    expect(current.script.nodes[0]?.transitions.map((edge) => edge.to)).toEqual(['done', 'retry']);
    fireEvent.focus(id);
    fireEvent.change(id, { target: { value: 'other' } });
    fireEvent.keyDown(id, { key: 'Escape' });
    expect(current.script.nodes[2]?.id).toBe('retry');
    expect(updates).not.toHaveBeenCalled();
    fireEvent.change(id, { target: { value: 'done2' } });
    expect(updates).not.toHaveBeenCalled();
    fireEvent.blur(id);
    expect(current.script.nodes[0]?.transitions.map((edge) => edge.to)).toEqual(['done', 'done2']);
    expect(diagnoseScript(current.script)).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Transition 1 matches for start' })).toBeDefined();
  });

  it('deletes a node and its incoming edges, and replaces a deleted start', () => {
    const source = script();
    const removedRetry = editScriptNode(source, { kind: 'delete', index: 2 }).script!;
    expect(removedRetry.nodes.map((node) => node.id)).toEqual(['start', 'done']);
    expect(removedRetry.nodes[0]?.transitions.map((edge) => edge.to)).toEqual(['done']);
    expect(diagnoseScript(removedRetry)).toEqual([]);
    const removedStart = editScriptNode(source, { kind: 'delete', index: 0 }).script!;
    expect(removedStart.start).toBe('done');
    expect(removedStart.nodes[1]?.transitions).toEqual([]);
    expect(removedStart.nodes.every((node) => node.id !== 'start')).toBe(true);
  });

  it('updates the rendered start selector when the start node is deleted', () => {
    let currentScript = script();
    function Harness() {
      const [config, setConfig] = useState<AgentConfig>({
        ...emptyAgentConfig(),
        script: currentScript,
      });
      return (
        <ScriptEditor
          config={config}
          update={(next) => {
            currentScript = next.script!;
            setConfig(next);
          }}
        />
      );
    }
    render(<Harness />);
    const row = screen.getByRole('textbox', { name: 'Node 1 ID' }).closest('tr')!;
    fireEvent.click(within(row).getAllByRole('button', { name: 'Remove' }).at(-1)!);
    expect((screen.getByRole('combobox', { name: 'Start node' }) as HTMLSelectElement).value).toBe(
      'done',
    );
    expect((screen.getByRole('textbox', { name: 'Node 1 ID' }) as HTMLInputElement).value).toBe(
      'done',
    );
    expect(currentScript.start).toBe('done');
    expect(
      currentScript.nodes.flatMap((node) => node.transitions).some((edge) => edge.to === 'start'),
    ).toBe(false);
    expect(screen.queryByText('The start node does not exist.')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Start node is now done.');
  });
});
