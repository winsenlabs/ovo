// Client-side check of a routing eval corpus before it is sent: JSON array or JSONL of
// `RoutingEvalCase` (design 3.3). The server is the authority and runs the same strict check; this
// one exists so the first bad case is named at once, not after an upload. The console does not
// bundle the contract's schema validator, so the rules are mirrored here by hand.
export const CORPUS_LIMITS = Object.freeze({ cases: 500, bytes: 1024 * 1024, tags: 10, turns: 20 });

type Rule = (value: unknown) => string | null;

/** A problem under a field or an entry: `.expect` + `.status must…` reads `.expect.status must…`. */
const under = (prefix: string, problem: string) =>
  /^[.[]/.test(problem) ? `${prefix}${problem}` : `${prefix} ${problem}`;
type Shape = Record<string, Rule>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pattern =
  (regex: RegExp, expected: string): Rule =>
  (value) =>
    typeof value === 'string' && regex.test(value) ? null : `must be ${expected}`;
const text =
  (max: number, min = 0): Rule =>
  (value) =>
    typeof value === 'string' && value.trim().length >= min && value.length <= max
      ? null
      : `must be text of ${min ? `${min} to ` : 'up to '}${max} characters`;
const oneOf =
  (...options: string[]): Rule =>
  (value) =>
    typeof value === 'string' && options.includes(value)
      ? null
      : `must be one of ${options.join(', ')}`;
const bool: Rule = (value) => (typeof value === 'boolean' ? null : 'must be true or false');
const unit: Rule = (value) =>
  typeof value === 'number' && value >= 0 && value <= 1 ? null : 'must be a number from 0 to 1';
const nullable =
  (rule: Rule): Rule =>
  (value) =>
    value === null ? null : rule(value);

const KEY = pattern(
  /^[a-z][a-z0-9_-]{0,79}$/,
  'a key: lower case letters, digits, - or _, starting with a letter',
);
const LANGUAGE = pattern(/^[a-z]{2,3}$/, 'a language code such as en or hi');
const E164 = pattern(/^\+[1-9][0-9]{0,14}$/, 'an E.164 number such as +918040000001');
const ISO_TIME = (value: unknown) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value))
    ? null
    : 'must be an ISO date-time such as 2026-10-20T09:30:00+05:30';

const array =
  (item: Rule, max: number): Rule =>
  (value) => {
    if (!Array.isArray(value)) return 'must be a list';
    if (value.length > max) return `must have at most ${max} entries`;
    for (const [index, entry] of value.entries()) {
      const problem = item(entry);
      if (problem) return under(`[${index}]`, problem);
    }
    return null;
  };

const record =
  (key: Rule, item: Rule, max: number): Rule =>
  (value) => {
    if (!isRecord(value)) return 'must be an object';
    const entries = Object.entries(value);
    if (entries.length > max) return `must have at most ${max} entries`;
    for (const [name, entry] of entries) {
      const problem = key(name) ? `key ${key(name)}` : item(entry);
      if (problem) return under(`.${name}`, problem);
    }
    return null;
  };

/** An object with exactly these keys (all optional unless listed in `required`). */
const strict =
  (shape: Shape, required: readonly string[] = []): Rule =>
  (value) => {
    if (!isRecord(value)) return 'must be an object';
    for (const name of Object.keys(value))
      if (!(name in shape)) return `.${name} is not a known field`;
    for (const name of required) if (value[name] === undefined) return `.${name} is required`;
    for (const [name, rule] of Object.entries(shape)) {
      const problem = value[name] === undefined ? null : rule(value[name]);
      if (problem) return under(`.${name}`, problem);
    }
    return null;
  };

const TURN_SHAPES: Record<string, Rule> = {
  speech: strict({ text: text(500, 1) }, ['text']),
  dtmf: strict({ digits: pattern(/^[0-9*#]{1,8}$/, '1 to 8 of 0-9, * or #') }, ['digits']),
  silence: strict({}),
};
const TURN: Rule = (value) => {
  if (!isRecord(value)) return 'must be an object';
  const { kind, ...rest } = value;
  const shape = typeof kind === 'string' ? TURN_SHAPES[kind] : undefined;
  return shape ? shape(rest) : '.kind must be one of speech, dtmf, silence';
};

const ANSWER = strict(
  {
    node: KEY,
    engine: oneOf('decision', 'llm', 'external'),
    outcome: oneOf('matched', 'no_match', 'low_confidence', 'timeout', 'error', 'disabled'),
    branch: nullable(KEY),
    confidence: unit,
    language: LANGUAGE,
    slots: record(pattern(/^[a-z][a-z0-9_]{0,39}$/, 'a context key'), KEY, 16),
    clarify: text(200),
    reason: text(80),
    repeat: bool,
  },
  ['node', 'engine'],
);

const FAULTS = strict({
  fullMembers: array(strict({ poolId: text(80, 1), memberId: KEY }, ['poolId', 'memberId']), 100),
  failedReleases: array(
    strict({ releaseId: text(80, 1), reason: oneOf('compose_failed', 'timeout') }, ['releaseId']),
    100,
  ),
  queues: record(KEY, oneOf('queue_closed', 'queue_unavailable', 'no_operators', 'queue_full'), 32),
});

const EXPECT: Rule = (value) => {
  const problem = strict({
    status: oneOf('agent', 'queue', 'human', 'end', 'callback'),
    path: array(KEY, 32),
    node: KEY,
    branches: record(KEY, KEY, 32),
    pool: text(120, 1),
    member: KEY,
    agentId: text(200, 1),
    queue: KEY,
    language: LANGUAGE,
    fallback: oneOf('none', 'default', 'human', 'callback', 'end', 'limit', 'release_default'),
    clarify: bool,
  })(value);
  if (problem) return problem;
  return Object.keys(value as object).length ? null : 'must assert at least one thing';
};

const CASE = strict(
  {
    id: pattern(/^[a-z0-9][a-z0-9_.-]{0,79}$/, 'an id: lower case letters, digits, . - or _'),
    description: text(300),
    tags: array(KEY, CORPUS_LIMITS.tags),
    call: strict({
      from: E164,
      to: E164,
      variables: record(pattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'a variable name'), text(200), 20),
      at: ISO_TIME,
    }),
    turns: array(TURN, CORPUS_LIMITS.turns),
    answers: array(ANSWER, 100),
    faults: FAULTS,
    expect: EXPECT,
  },
  ['id', 'expect'],
);

export type CorpusResult =
  { ok: true; cases: Record<string, unknown>[] } | { ok: false; message: string };

function parseLines(source: string): unknown[] | string {
  const cases: unknown[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      cases.push(JSON.parse(line));
    } catch {
      return `Line ${index + 1} is not valid JSON.`;
    }
  }
  return cases;
}

/** A JSON array or JSONL corpus, checked case by case; the message names the first failing case. */
export function parseRoutingCorpus(source: string): CorpusResult {
  if (new TextEncoder().encode(source).byteLength > CORPUS_LIMITS.bytes)
    return { ok: false, message: 'The corpus is over 1 MiB. Split it into smaller runs.' };
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, message: 'Paste or upload a corpus first.' };
  let parsed: unknown[] | string;
  if (trimmed.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      parsed = Array.isArray(value) ? value : 'The corpus must be a JSON array or JSONL.';
    } catch {
      parsed = 'The corpus is not valid JSON.';
    }
  } else parsed = parseLines(trimmed);
  if (typeof parsed === 'string') return { ok: false, message: parsed };
  if (!parsed.length) return { ok: false, message: 'The corpus has no cases.' };
  if (parsed.length > CORPUS_LIMITS.cases)
    return {
      ok: false,
      message: `The corpus has ${parsed.length} cases; the limit is ${CORPUS_LIMITS.cases}.`,
    };
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : null;
    const problem = CASE(entry);
    const where = `Case ${index + 1}${id ? ` (${id})` : ''}`;
    if (problem) return { ok: false, message: `${where}: ${problem.replace(/^\./, '')}` };
    if (seen.has(id!)) return { ok: false, message: `${where}: id is used by an earlier case.` };
    seen.add(id!);
  }
  return { ok: true, cases: parsed as Record<string, unknown>[] };
}
