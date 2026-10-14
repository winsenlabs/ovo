// Which turn detector a replay runs. `rules` is OVO's default detector with the agent's row (and any
// `--detector-config` over it). Any other detector is a module: `module:<path>[#export]`, whose
// export is a TurnDetectorFactory or a function taking the row and returning one (a plugin's
// `createTurnDetector`), so a new detector package can be baked off without changing the harness.
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TurnDetectorFactory } from '@winsendotai/ovo-contracts';
import { createTurnDetector } from '@winsendotai/ovo-plugin-turns';

export interface DetectorChoice {
  /** For the report. */
  name: string;
  row: Record<string, unknown>;
  factory: TurnDetectorFactory;
}

function isFactory(value: unknown): value is TurnDetectorFactory {
  return Boolean(value && typeof (value as TurnDetectorFactory).create === 'function');
}

export async function chooseDetector(
  spec: string,
  agentRow: Record<string, unknown>,
  config: Record<string, unknown> = {},
): Promise<DetectorChoice> {
  // The agent's row, so a model detector that keeps the default's safety rules gets them too. Idle
  // prompts off: a recorded caller cannot answer them, and the call's timing would be lost to a
  // hang-up the live call never had. A row (or --detector-config) that sets idle keeps it.
  const row = { idle: null, ...agentRow, ...config };
  if (spec === 'rules') return { name: 'rules', row, factory: createTurnDetector(row) };
  if (!spec.startsWith('module:'))
    throw new Error(`unknown detector ${spec}: use rules or module:<path>[#export]`);
  const [path, name = 'createTurnDetector'] = spec.slice('module:'.length).split('#');
  const url = pathToFileURL(isAbsolute(path!) ? path! : resolve(path!)).href;
  const loaded = (await import(url)) as Record<string, unknown>;
  const exported = loaded[name] ?? loaded.default;
  // A model detector may load its model first: the function may return a promise.
  const factory = isFactory(exported)
    ? exported
    : typeof exported === 'function'
      ? await (exported as (row: unknown) => unknown)(row)
      : undefined;
  if (!isFactory(factory)) throw new Error(`${spec}: ${name} is not a turn detector factory`);
  return { name: spec, row, factory };
}
