import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as contracts from '../src/index.ts';
import type {
  Behavior,
  CallEvent,
  EventSink,
  Execution,
  ExecutionRequest,
  Inference,
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
  OperationRecord,
  OperationStore,
  Release,
  SecretResolver,
  Speech,
  SpeechReceipt,
  ToolConnection,
  ToolConnector,
} from '../src/index.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((file) =>
  file.endsWith('.ts'),
);
const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(join(SRC, file), 'utf8'), ts.ScriptTarget.Latest, true);

describe('contracts package surface (§2.1)', () => {
  it('keeps index.ts to re-exports only', () => {
    const statements = parse('index.ts').statements;
    expect(statements.length).toBeGreaterThan(30);
    for (const statement of statements)
      expect(
        ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
        statement.getText(),
      ).toBe(true);
  });

  it('imports nothing but zod and relative modules', () => {
    const specifiers = files.flatMap((file) =>
      parse(file)
        .statements.filter(
          (statement): statement is ts.ImportDeclaration | ts.ExportDeclaration =>
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier !== undefined,
        )
        .map((statement) => ({
          file,
          specifier: (statement.moduleSpecifier as ts.StringLiteral).text,
        })),
    );
    expect(specifiers.length).toBeGreaterThan(50);
    expect(
      specifiers.filter(({ specifier }) => specifier !== 'zod' && !specifier.startsWith('.')),
    ).toEqual([]);
  });

  it('still exports every value the pre-split index.ts exported', () => {
    for (const name of [
      'AgentConfig',
      'DurableEvent',
      'JsonSchema',
      'Manifest',
      'Mode',
      'ProcessingSpeech',
      'ScriptGraph',
      'ToolDefinition',
      'readDurableEvent',
    ])
      expect(contracts, name).toHaveProperty(name);
  });

  it('still exports every type the pre-split index.ts exported', () => {
    // A missing export fails typecheck here, before the test runs.
    expectTypeOf<Behavior['respond']>().toBeFunction();
    expectTypeOf<Execution['execute']>().toBeFunction();
    expectTypeOf<Inference['generate']>().toBeFunction();
    expectTypeOf<OperationStore['settle']>().toBeFunction();
    expectTypeOf<ToolConnector['invoke']>().toBeFunction();
    expectTypeOf<Speech['speak']>().toBeFunction();
    expectTypeOf<EventSink['append']>().toBeFunction();
    expectTypeOf<SecretResolver['resolve']>().toBeFunction();
    expectTypeOf<Release['plugins']>().toEqualTypeOf<{ id: string; version: string }[]>();
    expectTypeOf<CallEvent['sequence']>().toEqualTypeOf<number>();
    expectTypeOf<SpeechReceipt['state']>().toEqualTypeOf<'completed' | 'interrupted'>();
    expectTypeOf<ExecutionRequest['confirmed']>().toEqualTypeOf<boolean>();
    expectTypeOf<OperationRecord['state']>().toEqualTypeOf<
      'intent' | 'running' | 'succeeded' | 'failed' | 'unknown'
    >();
    expectTypeOf<InferenceRequest['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<InferenceReply['kind']>().toEqualTypeOf<'text' | 'tool'>();
    expectTypeOf<InferenceStreamEvent['kind']>().toEqualTypeOf<'text-delta' | 'tool' | 'finish'>();
    expectTypeOf<ToolConnection['auth']>().toEqualTypeOf<'none' | 'bearer'>();
  });
});
