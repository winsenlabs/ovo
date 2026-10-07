import { describe, expect, it } from 'vitest';
import { describeRoute } from '../components/studio/flow-shapes.ts';

type Intent = Parameters<typeof describeRoute>[0];
const intent = (over: Partial<Intent>): Intent => ({
  key: 'intent',
  description: 'An intent',
  phrases: [],
  ...over,
});

describe('describeRoute', () => {
  it('describes a hold intent instead of saying it goes nowhere', () => {
    expect(describeRoute(intent({ hold: true }))).toBe('asks the current question again');
  });

  it('still describes repeat and plain routes', () => {
    expect(describeRoute(intent({ repeat: true }))).toBe('repeats the last lines');
    expect(describeRoute(intent({ next: 'end' }))).toBe('→ end');
  });
});
