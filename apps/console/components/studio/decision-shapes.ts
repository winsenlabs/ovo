import type { AgentConfig } from '../../lib/api';

/** The authored decision shapes, the starter content and the type switch, shared by both editors. */
export type Policy = NonNullable<AgentConfig['decision']>;
export type Question = Policy['questions'][number];
export type Outcome = { say?: string };

export const SOURCES: { id: Policy['state']['sources'][number]; label: string; help: string }[] = [
  { id: 'last-turn', label: 'Last caller turn', help: 'What the caller just said.' },
  { id: 'transcript', label: 'Transcript', help: 'The recent conversation, both sides.' },
  { id: 'variables', label: 'Call variables', help: 'Values the campaign passed in.' },
  { id: 'context', label: 'Briefing', help: 'The agent’s context text.' },
];

/**
 * Starter text, not placeholders. Every field the model reads is required to be non-empty by the
 * shared contract, and the draft is saved on each edit, so a seeded question has to be valid the
 * moment it appears or the first save fails on a draft nobody has touched yet.
 */
export const STARTER = {
  instructions: 'Describe the question this decision answers.',
  option: 'Describe what this answer means.',
  yes: 'Describe what counts as yes.',
  no: 'Describe what counts as no.',
  rubric: ['Describe the lowest level.', 'Describe the highest level.'],
} as const;

export const choiceOptions = () => [
  { key: 'option_1', description: STARTER.option, outcome: {} },
  { key: 'option_2', description: STARTER.option, outcome: {} },
];

export const DEFAULT_QUESTION = (): Question => ({
  type: 'choice',
  id: 'intent',
  purpose: '',
  instructions: STARTER.instructions,
  threshold: 0.8,
  fallback: 'llm',
  options: choiceOptions(),
});

/** A fresh question of the chosen type, keeping what every shape shares. */
export function retyped(question: Question, type: Question['type']): Question {
  const shared = {
    id: question.id,
    purpose: question.purpose,
    instructions: question.instructions,
    threshold: question.threshold,
    fallback: question.fallback,
  };
  if (type === 'choice') return { ...shared, type: 'choice', options: choiceOptions() };
  if (type === 'noul')
    return {
      ...shared,
      type: 'noul',
      yes: { description: STARTER.yes, outcome: {} },
      no: { description: STARTER.no, outcome: {} },
    };
  return {
    ...shared,
    type: 'score',
    rubric: [...STARTER.rubric],
    bands: [{ atLeast: 0, outcome: {} }],
  };
}

/** `say` empty means "record the answer and let the LLM reply", so it is removed, not blanked. */
export const withSay = (outcome: Outcome, say: string): Outcome =>
  say.trim() ? { ...outcome, say } : {};
