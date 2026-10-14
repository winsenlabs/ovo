// Provider keys for live runs. They stay inside this process: read from a keys file (KEY=value
// lines, as in ~/.ovo-eval/keys.env) or from `OVO_EVAL_<KEY>` variables, never from arguments, and
// never printed. Only the names of the keys present are reported.
import { readFile } from 'node:fs/promises';
import type { KeyName } from './configs.ts';

const NAMES: readonly KeyName[] = [
  'ELEVENLABS_API_KEY',
  'ASSEMBLYAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'SARVAM_API_KEY',
  'CARTESIA_API_KEY',
  'OPENAI_API_KEY',
];

export type Keys = Partial<Record<KeyName, string>>;

/** `KEY=value` lines; blank lines, comments and `export ` prefixes allowed, quotes stripped. */
export function parseKeysFile(text: string): Keys {
  const keys: Keys = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const name = match[1] as KeyName;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    if (NAMES.includes(name) && value) keys[name] = value;
  }
  return keys;
}

/** The keys file's keys, else the environment's `OVO_EVAL_*` ones. */
export async function loadKeys(
  file: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Keys> {
  const keys: Keys = {};
  for (const name of NAMES) {
    const value = env[`OVO_EVAL_${name}`];
    if (value) keys[name] = value;
  }
  return file ? { ...keys, ...parseKeysFile(await readFile(file, 'utf8')) } : keys;
}
