import type { DecisionPort, Inference } from '@winsendotai/ovo-contracts';
import { jevDecision, resolveBinding } from '@winsendotai/ovo-plugin-decision-jev';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import type { ScoreInput } from '@winsendotai/ovo-plugin-router';
import { readKeys } from '../audio/stt-configs.ts';
import { checkBaseUrl, DEFAULT_LLM_PROVIDER, LLM_PROVIDERS, type LlmChoice } from './live-llm.ts';

/** What `--live` can run for real. A run is `live` the moment any engine here is on. */
export const LIVE_ENGINES = ['llm', 'decision'] as const;

/** Builds the classifier's inference from the run's choices. Replaceable in tests. */
export type InferenceFactory = (choice: LlmChoice) => Inference & { close?(): Promise<void> };
/** Builds the decision engine's port. Replaceable in tests. */
export type DecisionFactory = (config: {
  apiKey: string;
  model?: string;
  calibrationLabel: string;
}) => DecisionPort;

export interface LiveFactories {
  inference?: InferenceFactory;
  decision?: DecisionFactory;
}

/** The choices of a live run: flags first, then `OVO_EVAL_LLM_*` in the environment. */
export interface LiveOptions {
  live: string;
  keys: string | undefined;
  /** `--llm-model` / `OVO_EVAL_LLM_MODEL` */
  model?: string;
  /** `--llm-provider` / `OVO_EVAL_LLM_PROVIDER` (default `openai`) */
  provider?: string;
  /** `--llm-key-env` / `OVO_EVAL_LLM_KEY_ENV`: the variable holding the key (default: the provider's own). */
  keyEnv?: string;
  /** `--llm-base-url` / `OVO_EVAL_LLM_BASE_URL`: an endpoint compatible with the provider's API. */
  baseUrl?: string;
  /** `--decision-model` / `OVO_EVAL_DECISION_MODEL` */
  decisionModel?: string;
  /** `--decision-calibration-label` / `OVO_EVAL_DECISION_CALIBRATION_LABEL`: required for `decision`. */
  calibrationLabel?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

const KEY_NAME = /^[A-Z][A-Z0-9_]{0,79}$/;

const nodeInference: InferenceFactory = (choice) => {
  const net = createNodeNet();
  const provider = LLM_PROVIDERS[choice.provider]!;
  return Object.assign(provider.create(net, choice), { close: () => net.close() });
};

const jev: DecisionFactory = ({ apiKey, model, calibrationLabel }) =>
  jevDecision(
    createNodeNet(),
    apiKey,
    resolveBinding({ calibrationLabel, ...(model ? { model } : {}) }),
  );

/**
 * `--live llm,decision`: the engines run against the real services, so the scorecard measures them
 * as well as the tree. The LLM classifier's provider, model, key variable and base URL are choices
 * of the run (flags, or `OVO_EVAL_LLM_PROVIDER|MODEL|KEY_ENV|BASE_URL`); its key is read from the
 * keys file (or that name with `OVO_EVAL_` before it, in the environment). The decision engine runs
 * on the Jev adapter with `JEV_API_KEY` and a calibration label. The external engine cannot run
 * from the CLI: it needs the release's own signed webhook host and secrets.
 */
export async function liveSetup(
  options: LiveOptions,
  factories: LiveFactories = {},
): Promise<{ live: NonNullable<ScoreInput['live']>; close(): Promise<void> }> {
  const env = options.env ?? process.env;
  const choose = (flag: string | undefined, name: string) => flag ?? env[`OVO_EVAL_${name}`];
  const wanted = options.live
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unsupported = wanted.filter((name) => !(LIVE_ENGINES as readonly string[]).includes(name));
  if (!wanted.length || unsupported.length)
    throw new Error(
      `--live ${options.live}: only ${LIVE_ENGINES.join(', ')} can run live from the CLI` +
        (unsupported.length
          ? ` (not ${unsupported.join(', ')}: they need the release's own services)`
          : ''),
    );
  const mode: Partial<Record<'llm' | 'decision', 'live'>> = {};
  const ports: NonNullable<ScoreInput['live']>['ports'] = {};
  const closers: (() => Promise<void> | void)[] = [];

  if (wanted.includes('llm')) {
    const provider = choose(options.provider, 'LLM_PROVIDER') ?? DEFAULT_LLM_PROVIDER;
    const entry = Object.hasOwn(LLM_PROVIDERS, provider) ? LLM_PROVIDERS[provider] : undefined;
    if (!entry)
      throw new Error(
        `--llm-provider ${provider}: one of ${Object.keys(LLM_PROVIDERS).join(', ')}`,
      );
    const model = choose(options.model, 'LLM_MODEL');
    if (!model) throw new Error('--live llm needs --llm-model <id> (or OVO_EVAL_LLM_MODEL)');
    const keyEnv = choose(options.keyEnv, 'LLM_KEY_ENV') ?? entry.keyEnv;
    if (!KEY_NAME.test(keyEnv)) throw new Error(`--llm-key-env ${keyEnv} is not a variable name`);
    const baseUrl = choose(options.baseUrl, 'LLM_BASE_URL');
    const apiKey = (await readKeys(options.keys, env, [keyEnv]))[keyEnv];
    if (!apiKey)
      throw new Error(
        `--live llm needs ${keyEnv} in the --keys file (or OVO_EVAL_ before that name in the environment)`,
      );
    const inference = (factories.inference ?? nodeInference)({
      provider,
      model,
      apiKey,
      ...(baseUrl ? { baseUrl: checkBaseUrl(baseUrl) } : {}),
    });
    mode.llm = 'live';
    ports.inference = inference;
    closers.push(() => inference.close?.());
  }

  if (wanted.includes('decision')) {
    const calibrationLabel = choose(options.calibrationLabel, 'DECISION_CALIBRATION_LABEL');
    if (!calibrationLabel)
      throw new Error(
        '--live decision needs --decision-calibration-label <label> (or OVO_EVAL_DECISION_CALIBRATION_LABEL)',
      );
    const apiKey = (await readKeys(options.keys, env)).JEV_API_KEY;
    if (!apiKey)
      throw new Error(
        '--live decision needs JEV_API_KEY in the --keys file (or OVO_EVAL_JEV_API_KEY in the environment)',
      );
    const model = choose(options.decisionModel, 'DECISION_MODEL');
    ports.decision = (factories.decision ?? jev)({
      apiKey,
      calibrationLabel,
      ...(model ? { model } : {}),
    });
    mode.decision = 'live';
  }

  return {
    live: { mode, ports },
    close: async () => {
      for (const close of closers) await close();
    },
  };
}
