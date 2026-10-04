import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SESSION_INPUT_JSON_SCHEMA } from '@winsendotai/ovo-contracts';
import { compileConfigSchema, runtimeAjv } from '../src/index.ts';

const FORMATS = [
  'uri',
  'email',
  'uuid',
  'date-time',
  'date',
  'time',
  'duration',
  'ipv4',
  'ipv6',
  'hostname',
];

describe('the single runtime Ajv instance (§3.2)', () => {
  it('accepts every zod string format as an annotation', () => {
    const check = compileConfigSchema({
      type: 'object',
      properties: Object.fromEntries(FORMATS.map((format) => [format, { type: 'string', format }])),
      additionalProperties: false,
    });
    // Annotation-only: zod enforces formats at apply time.
    expect(check(Object.fromEntries(FORMATS.map((format) => [format, 'not checked here'])))).toBe(
      true,
    );
    expect(check({ uri: 42 })).toBe(false);
  });

  it('stays strict', () => {
    expect(runtimeAjv.opts.strict).toBe(true);
    expect(runtimeAjv.opts.allErrors).toBe(true);
    expect(() => compileConfigSchema({ type: 'object', madeUp: true })).toThrow('strict mode');
    expect(() => compileConfigSchema({ type: 'string', format: 'credit-card' })).toThrow(
      'unknown format',
    );
    expect(() => compileConfigSchema({ type: ['string', 'number'] })).toThrow('allowUnionTypes');
  });

  it('compiles the SessionInput schema engines embed', () => {
    const check = compileConfigSchema(SESSION_INPUT_JSON_SCHEMA);
    const session = {
      mode: 'agent',
      language: 'en-IN',
      inputEnabled: true,
      variables: { name: 'Anita' },
      maxCallSeconds: 1800,
      acknowledgements: ['weak-playback-evidence'],
    };
    expect(check(session)).toBe(true);
    expect(check({ ...session, initialInput: 'hello' })).toBe(true);
    expect(check({ ...session, mode: 'chat' })).toBe(false);
    expect(check({ ...session, extra: 1 })).toBe(false);
    const { acknowledgements: _dropped, ...missing } = session;
    expect(check(missing)).toBe(false);
  });

  it('caches per schema object and never needs ajv-formats', () => {
    const schema = { type: 'object' };
    expect(compileConfigSchema(schema)).toBe(compileConfigSchema(schema));
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    for (const file of files)
      expect(readFileSync(join(src, file), 'utf8')).not.toMatch(
        /from ['"]ajv-formats['"]|import\(['"]ajv-formats/,
      );
  });
});
