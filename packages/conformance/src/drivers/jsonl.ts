import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The first line of every protocol fixture (§17). */
export interface JsonlFixtureHeader {
  source: string;
  /** ISO date, e.g. '2026-09-22'. */
  retrieved: string;
  /** What was copied verbatim from the source. */
  verbatim: readonly string[];
  /** What the source leaves unconfirmed (UNCONFIRMED items). */
  unconfirmed: readonly string[];
}

export interface JsonlFixtureLine {
  dir: 'in' | 'out';
  frame: unknown;
  /** Optional expectations a kit may check (decoded events, the command that encodes `frame`). */
  [extra: string]: unknown;
}

export interface JsonlFixture {
  name: string;
  header: JsonlFixtureHeader;
  lines: JsonlFixtureLine[];
}

export class JsonlFixtureError extends Error {
  constructor(name: string, message: string) {
    super(`${name}: ${message}`);
    this.name = 'JsonlFixtureError';
  }
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export function parseJsonlFixture(text: string, name = 'fixture'): JsonlFixture {
  const rows = text.split(/\r?\n/).filter((line) => line.trim());
  if (!rows.length) throw new JsonlFixtureError(name, 'empty fixture');
  const parse = (row: string, index: number): unknown => {
    try {
      return JSON.parse(row);
    } catch {
      throw new JsonlFixtureError(name, `line ${index + 1} is not JSON`);
    }
  };
  const header = parse(rows[0]!, 0) as Partial<JsonlFixtureHeader>;
  if (typeof header.source !== 'string' || !/^https?:\/\//.test(header.source))
    throw new JsonlFixtureError(name, 'header.source must be the documentation URL');
  if (typeof header.retrieved !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(header.retrieved))
    throw new JsonlFixtureError(name, 'header.retrieved must be an ISO date');
  if (!isStrings(header.verbatim))
    throw new JsonlFixtureError(name, 'header.verbatim must list strings');
  if (!isStrings(header.unconfirmed))
    throw new JsonlFixtureError(name, 'header.unconfirmed must list strings');
  const lines = rows.slice(1).map((row, index) => {
    const line = parse(row, index + 1) as Partial<JsonlFixtureLine>;
    if (line.dir !== 'in' && line.dir !== 'out')
      throw new JsonlFixtureError(name, `line ${index + 2} needs dir 'in' or 'out'`);
    if (!('frame' in line)) throw new JsonlFixtureError(name, `line ${index + 2} needs a frame`);
    return line as JsonlFixtureLine;
  });
  return { name, header: header as JsonlFixtureHeader, lines };
}

/** Reads and validates a `tests/fixtures/*.jsonl` protocol fixture. */
export function loadJsonlFixture(path: string | URL): JsonlFixture {
  const file = path instanceof URL ? fileURLToPath(path) : path;
  return parseJsonlFixture(readFileSync(file, 'utf8'), file.split('/').pop());
}
