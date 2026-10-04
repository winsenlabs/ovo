import { expect, it } from 'vitest';
import { speakArguments } from '../src/args-speaker.ts';
it('uses explicit currency format hints and nested redaction', () => {
  expect(
    speakArguments(
      { amount: 1000, account: { secretToken: 'hidden' } },
      { properties: { amount: { title: 'Amount', format: 'currency:INR' } } },
      'en-IN',
    ),
  ).toBe('Amount: 1,000 rupees, account: secret Token: [redacted]');
});
it('refuses oversized confirmation details', () => {
  expect(() => speakArguments({ text: 'x'.repeat(800) }, {}, 'en-IN')).toThrow('too large');
});
