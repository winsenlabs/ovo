import type { RoutingNode, RulesMatcher } from '@winsendotai/ovo-contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignerHarness, resetRouting, sampleDraft } from '../routing-test-support';
import { useDesigner } from './designer-context';
import { BranchList } from './branch-list';
import { EngineList } from './engine-list';
import { ExternalEditor } from './engine-external';
import { FallbackEditor } from './fallback-editor';
import { MatcherEditor } from './matcher-editors';
import { ModelEngineEditor } from './engine-model';
import { TargetEditor } from './target-editor';

vi.mock('../../../lib/data/routing-api', async (importActual) =>
  (await import('../routing-test-support')).routingApiModule(importActual as never),
);

beforeEach(() => resetRouting());
afterEach(() => cleanup());

const rules = (): RoutingNode => sampleDraft().nodes[0]!;
/** The first node, read live from the harness so edits show up. */
function LiveBranches({ onOpenNode }: { onOpenNode: (id: string) => void }) {
  return <BranchList node={useDesigner().draft.nodes[0]!} onOpenNode={onOpenNode} />;
}

describe('MatcherEditor', () => {
  const cases: [RulesMatcher, string, string, string][] = [
    [{ kind: 'dtmf', digits: '1' }, 'Digits the caller presses', '2', 'digits'],
    [{ kind: 'variable', name: 'segment', equals: ['vip'] }, 'Call variable', 'tier', 'name'],
    [
      { kind: 'keywords', words: ['refund'], maxWords: 12 },
      'Only in replies up to',
      '8',
      'maxWords',
    ],
  ];
  it.each(cases)('edits a %o matcher field by field', (matcher, label, value, key) => {
    const onChange = vi.fn();
    render(<MatcherEditor id="m" matcher={matcher} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: matcher.kind, [key]: key === 'maxWords' ? 8 : value }),
    );
  });
  it('checks digits, prefixes and languages inline', () => {
    const { rerender } = render(
      <MatcherEditor id="m" matcher={{ kind: 'dtmf', digits: 'abc' }} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Use 1 to 8 of 0-9, * or #')).toBeTruthy();
    rerender(
      <MatcherEditor
        id="m"
        matcher={{ kind: 'caller-id', prefixes: ['9140', '+9140'] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Not international.*9140/)).toBeTruthy();
    rerender(
      <MatcherEditor
        id="m"
        matcher={{ kind: 'script', languages: ['hindi'] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Not a language code: hindi/)).toBeTruthy();
  });
  it('edits phrases and the time rule', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MatcherEditor id="m" matcher={{ kind: 'phrases', phrases: ['yes'] }} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Exact replies'), { target: { value: 'no' } });
    fireEvent.keyDown(screen.getByLabelText('Exact replies'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'phrases', phrases: ['yes', 'no'] });
    const time: RulesMatcher = {
      kind: 'time',
      inside: true,
      hours: {
        timezone: 'Asia/Kolkata',
        weekly: { mon: [{ start: '09:00', end: '18:00' }] },
        closed: [],
      },
    };
    rerender(<MatcherEditor id="m" matcher={time} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Matches'), { target: { value: 'outside' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ inside: false }));
    expect(screen.queryByText('Only open during set hours')).toBeNull();
    expect(screen.getByLabelText('Monday opens')).toBeTruthy();
  });
});

describe('EngineList', () => {
  function Harness() {
    return (
      <DesignerHarness>
        <Inner />
      </DesignerHarness>
    );
  }
  function Inner() {
    return <EngineList node={rules()} onChange={onChange} />;
  }
  const onChange = vi.fn();
  it('reorders, removes and adds engines within the limit', () => {
    onChange.mockReset();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Move engine 1 down' }));
    expect(onChange.mock.lastCall![0].engines.map((e: { kind: string }) => e.kind)).toEqual([
      'llm',
      'rules',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove engine 2' }));
    expect(onChange.mock.lastCall![0].engines).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Engine to add'), { target: { value: 'external' } });
    expect(onChange.mock.lastCall![0].engines.at(-1).kind).toBe('external');
  });
  it('adds a rule and a condition to the rules engine', () => {
    onChange.mockReset();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(onChange.mock.lastCall![0].engines[0].rules).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add condition' })[0]!);
    expect(onChange.mock.lastCall![0].engines[0].rules[0].when).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Rule 1 condition 1 type'), {
      target: { value: 'time' },
    });
    expect(onChange.mock.lastCall![0].engines[0].rules[0].when[0].kind).toBe('time');
  });
});

describe('model and external engines', () => {
  it('edits instructions, threshold and the language switches', () => {
    const onChange = vi.fn();
    const llm = rules().engines[1] as never;
    render(<ModelEngineEditor id="e" engine={llm} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Confidence needed'), { target: { value: '0.8' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ threshold: 0.8 }));
    fireEvent.click(screen.getByRole('switch', { name: /let the model ask/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ generatedClarify: true }));
  });
  it('requires https, picks a secret and warns when external services are off', () => {
    const onChange = vi.fn();
    const engine = {
      kind: 'external' as const,
      endpoint: 'http://x.example.com',
      credentialId: '',
      timeoutMs: 1500,
      threshold: 0.5,
      send: { callerId: false, turnText: true, variables: [] },
      slots: [],
    };
    render(
      <DesignerHarness
        env={{
          status: {
            enabled: true,
            externalEnabled: false,
            transferEnabled: true,
            humanQueueEnabled: true,
          },
        }}
      >
        <ExternalEditor id="x" engine={engine} onChange={onChange} />
      </DesignerHarness>,
    );
    expect(screen.getByText('The endpoint must be an https address')).toBeTruthy();
    expect(screen.getByText(/switched off on this installation/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'cred-acd' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ credentialId: 'cred-acd' }),
    );
    fireEvent.click(screen.getByRole('switch', { name: "The caller's phone number" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ send: expect.objectContaining({ callerId: true }) }),
    );
  });
});

describe('FallbackEditor', () => {
  it('shows the terminal hint until the chain ends in default, callback or end', () => {
    const onChange = vi.fn();
    const node = { ...rules(), fallback: [{ kind: 'reask' as const, times: 1 }] };
    const { rerender } = render(
      <DesignerHarness>
        <FallbackEditor node={node} onChange={onChange} />
      </DesignerHarness>,
    );
    expect(screen.getByText(/must end with the default agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(onChange.mock.lastCall![0].fallback.at(-1).kind).toBe('end');
    rerender(
      <DesignerHarness>
        <FallbackEditor
          node={{ ...node, fallback: [{ kind: 'reask', times: 1 }, { kind: 'default' }] }}
          onChange={onChange}
        />
      </DesignerHarness>,
    );
    expect(screen.queryByText(/must end with the default agent/)).toBeNull();
  });
  it('switches a step kind, reorders and keeps at least one step', () => {
    const onChange = vi.fn();
    render(
      <DesignerHarness>
        <FallbackEditor node={rules()} onChange={onChange} />
      </DesignerHarness>,
    );
    fireEvent.change(screen.getByLabelText('Step 2'), { target: { value: 'callback' } });
    expect(onChange.mock.lastCall![0].fallback[1].kind).toBe('callback');
    fireEvent.click(screen.getByRole('button', { name: 'Move fallback step 1 down' }));
    expect(onChange.mock.lastCall![0].fallback[1].kind).toBe('reask');
  });
});

describe('BranchList and TargetEditor', () => {
  it('renames a branch on blur, rewriting the rules that name it, and refuses a taken key', () => {
    render(
      <DesignerHarness>
        <LiveBranches onOpenNode={vi.fn()} />
      </DesignerHarness>,
    );
    const key = screen.getAllByLabelText('Branch key')[0]!;
    fireEvent.change(key, { target: { value: 'support' } });
    fireEvent.blur(key);
    expect(screen.getByText('Node intent already has a branch support.')).toBeTruthy();
    expect((screen.getAllByLabelText('Branch key')[0] as HTMLInputElement).value).toBe('sales');
    fireEvent.change(key, { target: { value: 'buy' } });
    fireEvent.blur(key);
    expect((screen.getAllByLabelText('Branch key')[0] as HTMLInputElement).value).toBe('buy');
  });
  it('adds a branch pointing at the default agent and creates a child question', () => {
    const onOpenNode = vi.fn();
    render(
      <DesignerHarness>
        <LiveBranches onOpenNode={onOpenNode} />
      </DesignerHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add branch' }));
    expect(screen.getAllByLabelText('Branch key')).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Next question'), { target: { value: '__new__' } });
    expect(onOpenNode).toHaveBeenCalledWith('question');
  });
  it('picks a destination kind and its details', () => {
    const onChange = vi.fn();
    render(
      <DesignerHarness>
        <TargetEditor
          id="t"
          value={{ kind: 'pool', poolId: '', language: 'caller', skills: [] }}
          onChange={onChange}
        />
      </DesignerHarness>,
    );
    fireEvent.change(screen.getByLabelText('Pool'), {
      target: { value: 'a1111111-1111-4111-8111-111111111111' },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ poolId: 'a1111111-1111-4111-8111-111111111111' }),
    );
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'context' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ products: { context: 'product' } }),
    );
    fireEvent.change(screen.getByLabelText('Then'), { target: { value: 'human' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'human', queueId: '' });
  });
  it('offers only the queues the point has bound', () => {
    render(
      <DesignerHarness>
        <TargetEditor id="t" value={{ kind: 'human', queueId: '' }} onChange={vi.fn()} />
      </DesignerHarness>,
    );
    const select = screen.getByLabelText('Person queue');
    expect(within(select).getByRole('option', { name: 'desk' })).toBeTruthy();
  });
});
