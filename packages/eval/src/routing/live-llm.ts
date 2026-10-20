import type { Inference } from '@winsendotai/ovo-contracts';
import type { NetPort } from '@winsendotai/ovo-contracts';
import { openAiInference } from '@winsendotai/ovo-plugin-llm-openai';

/** What a live classifier is built from: the choices a run makes, never the plugin's own defaults. */
export interface LlmChoice {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/** One provider the live LLM engine can run on. Add an entry here when another inference plugin exists. */
export interface LlmProvider {
  /** The keys-file variable that holds this provider's key unless `--llm-key-env` names another. */
  keyEnv: string;
  create(net: NetPort, choice: LlmChoice): Inference;
}

export const LLM_PROVIDERS: Readonly<Record<string, LlmProvider>> = {
  openai: {
    keyEnv: 'OPENAI_API_KEY',
    create: (net, { apiKey, model, baseUrl }) =>
      openAiInference(net, apiKey, { model, ...(baseUrl ? { baseUrl } : {}) }),
  },
};

export const DEFAULT_LLM_PROVIDER = 'openai';

/** `https://host/v1`, no credentials, query or fragment; a plain `http:` base only on loopback. */
export function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--llm-base-url ${JSON.stringify(value)} is not a URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('--llm-base-url must be https (http only for localhost)');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('--llm-base-url cannot carry credentials, a query or a fragment');
  return value.replace(/\/+$/, '');
}
