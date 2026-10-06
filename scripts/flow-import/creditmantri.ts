import type { PocImportOptions } from './import-poc-flow.ts';

const here = (path: string) => new URL(path, import.meta.url).pathname;

/**
 * The CreditMantri collections flow: the POC's map imported with the POC's own defaults (agent
 * Ananya, helpline 1800 123 4567 from `lib/config.js`) and its decision preamble from `lib/jev.js`.
 * `pnpm flow:import --preset creditmantri` rewrites the fixture; a test fails when it drifts.
 */
export const CREDITMANTRI_PRESET = {
  input: here('./fixtures/poc-creditmantri/flow.js'),
  map: here('./fixtures/poc-creditmantri/conversation-map.md'),
  out: here('../../packages/plugin-evaluations/src/corpus/creditmantri-flow.json'),
  options: {
    name: 'CreditMantri EMI collections',
    context:
      'A CreditMantri collections agent is on a phone call about a missed loan EMI. The caller may reply in English, Hindi, Tamil, or a mix (Hinglish, Tanglish). `caller_reply` is a speech-to-text transcript and may contain recognition errors.',
    constants: { agent: 'Ananya', helpline: '1800 123 4567' },
    start: 'greet',
    source: {
      importer: 'scripts/flow-import',
      from: 'credit3-collections-poc lib/flow.js (2026-09-30)',
      sha256: 'a2aaf4dc15227f64e2367ab13395cb106a06657bbdb0e86f94327b0c8fb1330a',
    },
  } satisfies PocImportOptions,
};
