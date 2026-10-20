import type { Inference } from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { openAiInference } from '@winsendotai/ovo-plugin-llm-openai';
import type { ScoreInput } from '@winsendotai/ovo-plugin-router';
import { readKeys } from '../audio/stt-configs.ts';

/** What `--live` can run for real. A run is `live` the moment any engine here is on. */
export const LIVE_ENGINES = ['llm'] as const;

/** Builds the classifier's inference: OpenAI Responses with the key from the keys file. Replaceable in tests. */
export type InferenceFactory = (
  apiKey: string,
  model: string,
) => Inference & { close?(): Promise<void> };

const openAi: InferenceFactory = (apiKey, model) => {
  const net = createNodeNet();
  const inference = openAiInference(net, apiKey, { model });
  return Object.assign(inference, { close: () => net.close() });
};

/**
 * `--live llm --llm-model <id> --keys <file>`: the LLM classifier runs against the real model, so
 * the scorecard measures the model as well as the tree. The key is `OPENAI_API_KEY` in the keys
 * file (or that name with `OVO_EVAL_` before it, in the environment). Decision and external engines cannot be
 * run from the CLI: they need the release's decision service and webhook secrets.
 */
export async function liveSetup(
  options: { live: string; keys: string | undefined; model: string | undefined },
  factory: InferenceFactory = openAi,
): Promise<{ live: NonNullable<ScoreInput['live']>; close(): Promise<void> }> {
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
  if (!options.model) throw new Error('--live llm needs --llm-model <id>');
  const key = (await readKeys(options.keys)).OPENAI_API_KEY;
  if (!key)
    throw new Error(
      '--live llm needs OPENAI_API_KEY in the --keys file (or OVO_EVAL_ before that name in the environment)',
    );
  const inference = factory(key, options.model);
  return {
    live: { mode: { llm: 'live' }, ports: { inference } },
    close: async () => inference.close?.(),
  };
}
