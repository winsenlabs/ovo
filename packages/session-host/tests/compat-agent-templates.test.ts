import { describe, expect, it } from 'vitest';
import { validateSelections } from '../src/compat/index.ts';
import { carrier, codes, fixture, withConfig } from './compat-support.ts';

const variables = {
  type: 'object',
  properties: { name: { type: 'string' } },
  additionalProperties: false,
};
const agent = (over: Record<string, unknown>) =>
  withConfig(fixture(), { mode: 'agent', variables, ...over });

describe('template_variable_undeclared', () => {
  it('blocks a release whose opening reads an undeclared variable', () => {
    const input = agent({ opening: { lines: ['Hello {{nickname}}.'] } });
    expect(validateSelections(input, 'release')).toContainEqual(
      expect.objectContaining({
        code: 'template_variable_undeclared',
        severity: 'error',
        field: 'opening.lines.0',
      }),
    );
  });

  it('blocks a decision line or voicemail message that reads one', () => {
    const input = agent({
      voicemail: { action: 'message', message: 'Call {{agent_name}} back.' },
      decision: {
        enabled: true,
        questions: [
          {
            type: 'noul',
            id: 'done',
            instructions: 'Is the caller done?',
            threshold: 0.8,
            fallback: 'llm',
            yes: { description: 'Done', outcome: { say: 'Bye {{nick}}.', end: true } },
            no: { description: 'Not done', outcome: {} },
          },
        ],
        state: { sources: ['last-turn'] },
      },
    });
    const fields = validateSelections(input, 'release')
      .filter((issue) => issue.code === 'template_variable_undeclared')
      .map((issue) => issue.field);
    expect(fields).toEqual(['voicemail.message', 'decision.questions.0.yes.outcome.say']);
  });

  it('accepts declared variables and the date built-ins', () => {
    const input = agent({
      opening: { lines: ['Hello {{name}}, today is {{today}}.'] },
      context: 'Offer {{date_week}} at the latest.',
    });
    expect(codes(input, 'release')).not.toContain('template_variable_undeclared');
  });

  it('only warns for the briefing, which is rendered leniently', () => {
    const input = agent({ context: 'Mention {{campaign}}.' });
    expect(validateSelections(input, 'release')).toContainEqual(
      expect.objectContaining({
        code: 'template_variable_undeclared',
        severity: 'warning',
        field: 'context',
      }),
    );
  });
});

describe('an agent voicemail policy on a carrier without detection', () => {
  const noAmd = () =>
    fixture({
      carrier: { capabilities: { ...carrier, control: { ...carrier.control, amd: 'none' } } },
    });

  it('warns, because the opening then plays without waiting', () => {
    const input = withConfig(noAmd(), { mode: 'agent', voicemail: { action: 'hangup' } });
    expect(validateSelections(input, 'live')).toContainEqual(
      expect.objectContaining({ code: 'amd_unsupported', severity: 'warning' }),
    );
  });

  it('says nothing for a greet-first agent that authored no policy', () => {
    const input = withConfig(noAmd(), { mode: 'agent', opening: { lines: ['Hello.'] } });
    expect(codes(input, 'live')).not.toContain('amd_unsupported');
  });
});
