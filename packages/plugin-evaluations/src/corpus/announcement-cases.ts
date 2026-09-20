import type { EvaluationCase } from '../types.ts';

const names = [
  'Aarav',
  'Aditi',
  'Fatima',
  'Kabir',
  'Lakshmi',
  'Meera',
  'Neel',
  'Priya',
  'Ravi',
  'Sara',
];

export const announcementCases: EvaluationCase[] = [
  ...Array.from({ length: 25 }, (_, index): EvaluationCase => {
    const customer = names[index % names.length]!,
      invoice = `INV-${1000 + index}`,
      amount = [0, 1, 10.5, 999.99, 125000][index % 5]!,
      day = String((index % 25) + 1).padStart(2, '0'),
      due = `2026-10-${day}`,
      currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(
        amount,
      ),
      date = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'UTC' }).format(
        new Date(`${due}T00:00:00Z`),
      );
    return {
      id: `announcement-valid-${index + 1}`,
      mode: 'announcement',
      title: `Formats customer, invoice, INR amount and ISO due date variant ${index + 1}`,
      tags: ['variables', 'date', 'currency'],
      turns: [{ input: '', variables: { customer, invoice, amount, due } }],
      expected: {
        outputs: [`Hello ${customer}, invoice ${invoice} is ${currency} and due ${date}.`],
      },
      fixture: {},
    };
  }),
  ...['customer', 'invoice', 'amount', 'due', 'additional-field'].map(
    (field, index): EvaluationCase => {
      const variables: Record<string, unknown> = {
        customer: 'Aarav',
        invoice: 'INV-X',
        amount: 20,
        due: '2026-10-20',
      };
      if (field === 'additional-field') variables.unsafe = 'blocked';
      else delete variables[field];
      return {
        id: `announcement-invalid-${index + 1}`,
        mode: 'announcement',
        title:
          field === 'additional-field'
            ? 'Rejects undeclared announcement data'
            : `Rejects missing ${field}`,
        tags: ['validation', field],
        turns: [{ input: '', variables }],
        expected: { errorIncludes: 'Announcement variables failed schema validation' },
        fixture: {},
      };
    },
  ),
];
