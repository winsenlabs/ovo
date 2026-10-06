import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import {
  speechCacheOptionsFromEnv,
  DEFAULT_SPEECH_CACHE_OPTIONS,
} from '../../apps/worker/src/speech-cache-env.ts';
import { resolveVoiceTuning } from '../../packages/plugin-llm-openai/src/voice-tuning.ts';

const root = new URL('../../', import.meta.url).pathname;
const compose = readFileSync(join(root, 'infra/compose/compose.yaml'), 'utf8');
const reference = readFileSync(join(root, 'docs/env-reference.md'), 'utf8');

// A whole name only: `OVO_LLM_*` and `OVO_OPERATOR_[A-Z…]` patterns are prefixes, not variables.
const NAME = /OVO_[A-Z0-9_]*[A-Z0-9](?![A-Z0-9_[*])/g;

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry) && !/\.(?:test|spec)\.tsx?$/.test(entry))
      out.push(path);
  }
  return out;
}

function namesReadByServices(): Set<string> {
  const roots: string[] = [];
  for (const group of ['apps', 'packages'])
    for (const entry of readdirSync(join(root, group))) {
      if (group === 'apps' && entry === 'console')
        for (const sub of ['app', 'components', 'features', 'lib'])
          roots.push(join(root, 'apps/console', sub));
      else roots.push(join(root, group, entry, 'src'));
    }
  const names = new Set<string>();
  for (const directory of roots) {
    try {
      statSync(directory);
    } catch {
      continue;
    }
    for (const file of sourceFiles(directory))
      for (const name of readFileSync(file, 'utf8').match(NAME) ?? []) names.add(name);
  }
  return names;
}

const documented = new Set(reference.match(NAME) ?? []);

// The worker tuning variables Waves 1-4 added (OPS-10, Wave 2 deferred #9, Wave 4).
const WORKER_FORWARDED = [
  'OVO_WORKER_DRAIN_TIMEOUT_MS',
  'OVO_SPEECH_CACHE_TTL_MS',
  'OVO_SPEECH_CACHE_MAX_ENTRIES',
  'OVO_SPEECH_CACHE_MAX_BYTES',
  'OVO_SPEECH_CACHE_MAX_ENTRY_BYTES',
  'OVO_SPEECH_CACHE_MAX_PENDING',
  'OVO_SPEECH_CLIPS_MAX_BYTES',
  'OVO_SPEECH_CLIP_MAX_BYTES',
  'OVO_SPEECH_CLIPS_WORKSPACE_MAX_BYTES',
  'OVO_SPEECH_CLIPS_RETENTION_DAYS',
  'OVO_SPEECH_PRERENDER_ENABLED',
  'OVO_SPEECH_PRERENDER_CONCURRENCY',
  'OVO_SPEECH_PRERENDER_POLL_MS',
  'OVO_SPEECH_PERCALL_ENABLED',
  'OVO_SPEECH_PERCALL_SCOPE',
  'OVO_SPEECH_PERCALL_MAX_LINES',
  'OVO_STT_PRECONNECT',
  'OVO_NET_KEEP_ALIVE_MS',
  'OVO_NET_KEEP_ALIVE_MAX_MS',
  'OVO_PROVIDER_PREWARM',
  'OVO_LLM_REASONING_EFFORT',
  'OVO_LLM_TEXT_VERBOSITY',
  'OVO_LLM_SERVICE_TIER',
  'OVO_LLM_STORE',
  'OVO_TELEMETRY_PG_MAX_CONNECTIONS',
  'OVO_TELEMETRY_RETENTION_DAYS',
  'OVO_TELEMETRY_MAX_QUEUED_EVENTS',
  'OVO_CALL_EVENT_MAX_QUEUED_EVENTS',
  'OVO_OPERATIONS_PG_MAX_CONNECTIONS',
];

function workerEnvironment(): string {
  const start = compose.indexOf('environment: &worker');
  return compose.slice(start, compose.indexOf('\n    depends_on:', start) + 1);
}

describe('docs/env-reference.md', () => {
  it('documents every OVO_* variable a service reads', () => {
    const missing = [...namesReadByServices()].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('documents every OVO_* variable Compose sets or forwards', () => {
    const missing = [...new Set(compose.match(NAME) ?? [])]
      .filter((name) => !documented.has(name))
      .sort();
    expect(missing).toEqual([]);
  });
});

describe('Compose forwarding of the Wave 1-4 worker variables', () => {
  it.each(WORKER_FORWARDED)('forwards %s to both workers, empty when unset', (name) => {
    expect(workerEnvironment()).toContain(`      ${name}: \${${name}:-}\n`);
    expect(compose).toMatch(/worker-2:[\s\S]*environment:\n {6}<<: \*worker/);
  });

  it('keeps every forwarded value at its default when it is empty', () => {
    const empty = Object.fromEntries(WORKER_FORWARDED.map((name) => [name, '']));
    expect(speechCacheOptionsFromEnv(empty)).toEqual({
      ...DEFAULT_SPEECH_CACHE_OPTIONS,
      l1: {},
      prerender: { ...DEFAULT_SPEECH_CACHE_OPTIONS.prerender },
      perCall: { ...DEFAULT_SPEECH_CACHE_OPTIONS.perCall },
    });
    expect(resolveVoiceTuning('gpt-6-luna', {}, empty, 'b1')).toEqual(
      resolveVoiceTuning('gpt-6-luna', {}, {}, 'b1'),
    );
  });

  it('is still valid YAML', async () => {
    await expect(prettier.format(compose, { parser: 'yaml' })).resolves.toBeTypeOf('string');
  });
});

describe('Compose log rotation (OPS-17)', () => {
  it('bounds the json-file log of every service', () => {
    expect(compose).toContain(
      "x-logging: &logging\n  driver: json-file\n  options:\n    max-size: 20m\n    max-file: '5'\n",
    );
    const services = compose.slice(
      compose.indexOf('\nservices:\n'),
      compose.indexOf('\nvolumes:\n'),
    );
    const names = [...services.matchAll(/\n {2}([a-z0-9-]+):\n/g)].map((match) => match[1]);
    expect(names).toHaveLength(9);
    for (const name of names) {
      const start = services.indexOf(`\n  ${name}:\n`);
      const rest = services.slice(start + 1);
      const end = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
      expect(end < 0 ? rest : rest.slice(0, end + 1), name).toContain('    logging: *logging\n');
    }
  });
});
