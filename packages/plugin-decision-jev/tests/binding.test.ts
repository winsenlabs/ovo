import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_QUESTIONS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  JevBindingError,
  resolveBinding,
} from '../src/binding.ts';
import { JEV_ENDPOINT } from '../src/wire.ts';

const LABEL = 'collections-en-2026-09';

describe('resolveBinding', () => {
  it('fills every documented default from the calibration label alone', () => {
    expect(resolveBinding({ calibrationLabel: LABEL })).toEqual({
      model: DEFAULT_MODEL,
      endpoint: JEV_ENDPOINT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      calibrationLabel: LABEL,
      maxQuestionsPerRequest: DEFAULT_MAX_QUESTIONS,
    });
  });

  it.each([
    ['ABSENT binding', undefined],
    ['an empty binding', {}],
    ['an ABSENT calibrationLabel', { model: 'jev-latest' }],
    ['a blank calibrationLabel', { calibrationLabel: '   ' }],
    ['a non-string calibrationLabel', { calibrationLabel: 7 }],
  ])('refuses %s rather than defaulting the calibration identity', (_name, binding) => {
    expect(() => resolveBinding(binding)).toThrow(JevBindingError);
    expect(() => resolveBinding(binding)).toThrow(/requires a non-empty calibrationLabel/);
  });

  it('refuses a binding that is not an object', () => {
    expect(() => resolveBinding('jev-latest')).toThrow(/must be an object/);
    expect(() => resolveBinding([])).toThrow(/must be an object/);
    expect(() => resolveBinding(null)).toThrow(/must be an object/);
  });

  it.each([199, 10_001, 0, -1, 1.5, Number.NaN])('refuses timeoutMs %s', (timeoutMs) => {
    expect(() => resolveBinding({ calibrationLabel: LABEL, timeoutMs })).toThrow(
      /timeoutMs must be an integer in \[200, 10000\]/,
    );
  });

  it.each([200, 2000, 10_000])('accepts timeoutMs %i at the documented boundary', (timeoutMs) => {
    expect(resolveBinding({ calibrationLabel: LABEL, timeoutMs }).timeoutMs).toBe(timeoutMs);
  });

  it.each([0, -3, 2.5])('refuses maxQuestionsPerRequest %s', (maxQuestionsPerRequest) => {
    expect(() => resolveBinding({ calibrationLabel: LABEL, maxQuestionsPerRequest })).toThrow(
      /maxQuestionsPerRequest must be a positive integer/,
    );
  });

  it('refuses a blank model but accepts and trims a named one', () => {
    expect(() => resolveBinding({ calibrationLabel: LABEL, model: '  ' })).toThrow(
      /model must be a non-empty string/,
    );
    expect(resolveBinding({ calibrationLabel: LABEL, model: ' jev-2026-07-01 ' }).model).toBe(
      'jev-2026-07-01',
    );
  });

  it.each([
    ['another host', 'https://evil.example.com/v1/systemone'],
    ['another path', 'https://api.typesafe.ai/v1/decisions'],
    ['plain http', 'http://api.typesafe.ai/v1/systemone'],
    ['embedded credentials', 'https://u:p@api.typesafe.ai/v1/systemone'],
    ['a query string', 'https://api.typesafe.ai/v1/systemone?key=leak'],
    ['a loopback host', 'https://localhost/v1/systemone'],
    ['not a URL at all', 'systemone'],
  ])('refuses an endpoint naming %s', (_name, endpoint) => {
    expect(() => resolveBinding({ calibrationLabel: LABEL, endpoint })).toThrow(JevBindingError);
    expect(() => resolveBinding({ calibrationLabel: LABEL, endpoint })).toThrow(
      /endpoint is not usable/,
    );
  });

  it('accepts the pinned endpoint written out in full', () => {
    expect(resolveBinding({ calibrationLabel: LABEL, endpoint: JEV_ENDPOINT }).endpoint).toBe(
      JEV_ENDPOINT,
    );
  });
});
