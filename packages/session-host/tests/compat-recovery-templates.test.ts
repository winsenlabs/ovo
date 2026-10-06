import { describe, expect, it } from 'vitest';
import { validateSelections } from '../src/compat/index.ts';
import { fixture, withConfig } from './compat-support.ts';

describe('template_variable_undeclared for idle and recovery lines (AGT-11, AGT-12)', () => {
  it('blocks an idle or recovery line that reads an undeclared variable', () => {
    const input = withConfig(fixture(), {
      mode: 'agent',
      variables: { type: 'object', properties: { name: { type: 'string' } } },
      idle: { prompts: ['Are you there, {{name}}?'], finalLine: 'Goodbye {{nickname}}.' },
      recovery: { didntCatch: 'Sorry {{name}}, again?', exhausted: { line: 'Bye {{agent}}.' } },
    });
    const fields = validateSelections(input, 'release')
      .filter((issue) => issue.code === 'template_variable_undeclared')
      .map((issue) => issue.field);
    expect(fields).toEqual(['idle.finalLine', 'recovery.exhausted.line']);
  });
});
