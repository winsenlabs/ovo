import type { PocImportOptions } from './import-poc-flow.ts';

const here = (path: string) => new URL(path, import.meta.url).pathname;

/**
 * The CreditMantri collections flow: the POC's map (vendored from credit3-collections-poc as of
 * 2026-09-30) imported with the POC's own defaults: agent Ananya and helpline 1800 123 4567 from
 * `lib/config.js`, the decision preamble from `lib/jev.js`, `JEV_MIN_CONFIDENCE` 0.55.
 * `pnpm flow:import --preset creditmantri` rewrites the fixture; a test fails when it drifts.
 */
export const CREDITMANTRI_PRESET = {
  input: here('./fixtures/poc-creditmantri/flow.js'),
  map: here('./fixtures/poc-creditmantri/conversation-map.md'),
  out: here('../../packages/plugin-evaluations/src/corpus/creditmantri-flow.json'),
  options: {
    context:
      'A CreditMantri collections agent is on a phone call about a missed loan EMI. The caller may reply in English, Hindi, Tamil, or a mix (Hinglish, Tanglish). `caller_reply` is a speech-to-text transcript and may contain recognition errors.',
    constants: { agent: 'Ananya', helpline: '1800 123 4567' },
    start: 'greet',
    threshold: 0.55,
  } satisfies PocImportOptions,
};
