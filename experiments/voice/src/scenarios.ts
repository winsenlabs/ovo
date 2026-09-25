export const FAQ_INPUT = 'What are your support hours?';
export const FAQ_ANSWER = 'Support is available from 9 AM to 6 PM, Monday through Friday.';

export function deterministicFaq(input: string): string {
  const normalized = input
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (normalized === 'what are your support hours') return FAQ_ANSWER;
  return 'Please clarify your question.';
}
