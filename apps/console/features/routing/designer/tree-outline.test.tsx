import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignerHarness, resetRouting, sampleDraft } from '../routing-test-support';
import { TreeOutline } from './tree-outline';
import { TreeTab } from './tree-tab';

vi.mock('../../../lib/data/routing-api', async (importActual) =>
  (await import('../routing-test-support')).routingApiModule(importActual as never),
);
beforeEach(() => resetRouting());
afterEach(() => cleanup());

const tree = () => screen.getByRole('tree', { name: 'Questions and branches' });
const items = () => screen.getAllByRole('treeitem');

describe('TreeOutline', () => {
  it('is a tree of questions and branches with levels, set sizes and a single tab stop', () => {
    render(
      <DesignerHarness>
        <TreeOutline onOpen={vi.fn()} />
      </DesignerHarness>,
    );
    expect(tree()).toBeTruthy();
    expect(items().map((i) => i.getAttribute('aria-level'))).toEqual([
      '1',
      '2',
      '2',
      '3',
      '4',
      '4',
      '2',
    ]);
    expect(items()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(items()[1]!.getAttribute('aria-expanded')).toBeNull();
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
    expect(items()[1]!.getAttribute('aria-setsize')).toBe('3');
  });
  it('moves with the arrow keys, Home and End, keeping one tab stop', () => {
    render(
      <DesignerHarness>
        <TreeOutline onOpen={vi.fn()} />
      </DesignerHarness>,
    );
    items()[0]!.focus();
    fireEvent.keyDown(items()[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
    expect(items()[1]!.tabIndex).toBe(0);
    expect(items()[0]!.tabIndex).toBe(-1);
    fireEvent.keyDown(items()[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items().at(-1));
    fireEvent.keyDown(items().at(-1)!, { key: 'Home' });
    expect(document.activeElement).toBe(items()[0]);
    fireEvent.keyDown(items()[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[0]);
  });
  it('closes and opens with Left and Right, and steps in and out', () => {
    render(
      <DesignerHarness>
        <TreeOutline onOpen={vi.fn()} />
      </DesignerHarness>,
    );
    items()[0]!.focus();
    fireEvent.keyDown(items()[0]!, { key: 'ArrowLeft' });
    expect(items()).toHaveLength(1);
    expect(items()[0]!.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(items()[0]!, { key: 'ArrowRight' });
    expect(items()).toHaveLength(7);
    fireEvent.keyDown(items()[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(items()[1]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(items()[0]);
  });
  it('opens the question of a row on Enter, Space and click', () => {
    const onOpen = vi.fn();
    render(
      <DesignerHarness>
        <TreeOutline onOpen={onOpen} />
      </DesignerHarness>,
    );
    fireEvent.keyDown(items()[3]!, { key: 'Enter' });
    fireEvent.keyDown(items()[1]!, { key: ' ' });
    fireEvent.click(items()[0]!);
    expect(onOpen.mock.calls.map((c) => c[0])).toEqual(['support_kind', 'intent', 'intent']);
  });
  it('shows issues on the row they concern, as text', () => {
    const draft = sampleDraft();
    draft.nodes[0]!.branches[0] = { key: 'sales', description: 'x', next: 'ghost' };
    render(
      <DesignerHarness draft={draft}>
        <TreeOutline onOpen={vi.fn()} />
      </DesignerHarness>,
    );
    expect(screen.getAllByText('1 error').length).toBeGreaterThan(0);
  });
});

describe('TreeTab', () => {
  it('adds a question, opens it and lists the keyboard help; a viewer cannot add', () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <DesignerHarness>
        <TreeTab openId={undefined} onOpen={onOpen} />
      </DesignerHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    expect(onOpen).toHaveBeenCalledWith('question');
    expect(screen.getByText('Enter or Space')).toBeTruthy();
    rerender(
      <DesignerHarness canEdit={false}>
        <TreeTab openId={undefined} onOpen={onOpen} />
      </DesignerHarness>,
    );
    expect(screen.queryByRole('button', { name: 'Add question' })).toBeNull();
  });
  it('opens the drawer for the open question and edits go into the working copy', () => {
    render(
      <DesignerHarness>
        <TreeTab openId="intent" onOpen={vi.fn()} />
      </DesignerHarness>,
    );
    const drawer = screen.getByRole('dialog', { name: 'Question: intent' });
    fireEvent.change(screen.getByLabelText('Question id'), { target: { value: 'Bad Id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByText(/lowercase letters/i)).toBeTruthy();
    expect(drawer).toBeTruthy();
    expect(screen.getByText('This is the first question callers hear.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove engine 2' })).toBeTruthy();
  });
});
