import { createHash } from 'node:crypto';
import { canonicalJson } from '@winsendotai/ovo-contracts';
import type { EvaluationCase } from './types.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODES = new Set(['announcement', 'faq', 'context', 'agent']);

export function validateCases(value: unknown): EvaluationCase[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000)
    throw new TypeError('Dataset versions require 1 to 1000 cases');
  const seen = new Set<string>();
  return value.map((entry, index) => validateCase(entry, index, seen));
}

function validateCase(value: unknown, index: number, seen: Set<string>): EvaluationCase {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`Case ${index} must be an object`);
  const row = value as Record<string, unknown>;
  rejectUnknown(row, ['id', 'mode', 'title', 'tags', 'turns', 'expected', 'fixture'], index);
  const id = text(row.id, `Case ${index} id`, 128);
  if (!ID.test(id) || seen.has(id))
    throw new TypeError(`Case ${index} has invalid or duplicate id`);
  seen.add(id);
  if (!MODES.has(String(row.mode))) throw new TypeError(`Case ${id} has invalid mode`);
  if (!Array.isArray(row.tags) || row.tags.length > 20)
    throw new TypeError(`Case ${id} tags must be a bounded array`);
  const tags = row.tags.map((tag) => text(tag, `Case ${id} tag`, 64));
  if (!Array.isArray(row.turns) || row.turns.length < 1 || row.turns.length > 10)
    throw new TypeError(`Case ${id} requires 1 to 10 turns`);
  const turns = row.turns.map((turn, turnIndex) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn))
      throw new TypeError(`Case ${id} turn ${turnIndex} must be an object`);
    const object = turn as Record<string, unknown>;
    rejectUnknown(object, ['input', 'variables'], index);
    return {
      input: text(object.input, `Case ${id} input`, 10_000, true),
      variables: jsonObject(object.variables, `Case ${id} variables`),
    };
  });
  const expected = jsonObject(row.expected, `Case ${id} expected`, false);
  const fixture = jsonObject(row.fixture, `Case ${id} fixture`, false);
  rejectFields(
    expected,
    ['outputs', 'outputIncludes', 'errorIncludes', 'operationCount', 'operationStates'],
    `Case ${id} expected`,
  );
  rejectFields(
    fixture,
    ['inference', 'inferenceDelayMs', 'toolResults', 'toolFailures', 'cancelAfterMs'],
    `Case ${id} fixture`,
  );
  if (expected.outputs !== undefined)
    stringArray(expected.outputs, `Case ${id} outputs`, 10, 20_000);
  if (expected.outputIncludes !== undefined)
    stringArray(expected.outputIncludes, `Case ${id} outputIncludes`, 10, 20_000);
  if (fixture.toolFailures !== undefined)
    stringArray(fixture.toolFailures, `Case ${id} toolFailures`, 100, 120);
  return structuredClone({
    id,
    mode: row.mode,
    title: text(row.title, `Case ${id} title`, 200),
    tags,
    turns,
    expected,
    fixture,
  }) as EvaluationCase;
}

export function datasetFingerprint(cases: EvaluationCase[]): string {
  return valueFingerprint(cases);
}

export function valueFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function releaseEvaluationFingerprint(release: {
  config: unknown;
  plugins: unknown;
  providerBindings?: unknown;
  mcpTools?: unknown;
}): string {
  return valueFingerprint({
    config: release.config,
    plugins: release.plugins,
    providerBindings: release.providerBindings ?? {},
    mcpTools: release.mcpTools ?? {},
  });
}

function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max)
    throw new TypeError(`${name} must be a string up to ${max} characters`);
  return value;
}
function jsonObject(value: unknown, name: string, optional = true): Record<string, unknown> {
  if (value === undefined && optional) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  JSON.stringify(value);
  return structuredClone(value as Record<string, unknown>);
}
function rejectUnknown(row: Record<string, unknown>, allowed: string[], index: number) {
  const key = Object.keys(row).find((candidate) => !allowed.includes(candidate));
  if (key) throw new TypeError(`Case ${index} has unknown field ${key}`);
}
function rejectFields(row: Record<string, unknown>, allowed: string[], name: string) {
  const key = Object.keys(row).find((candidate) => !allowed.includes(candidate));
  if (key) throw new TypeError(`${name} has unknown field ${key}`);
}
function stringArray(value: unknown, name: string, maxItems: number, maxLength: number) {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || item.length > maxLength)
  )
    throw new TypeError(`${name} must be a bounded string array`);
}
