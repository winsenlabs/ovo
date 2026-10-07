import type { AgentFlow, FlowIntent } from '../../packages/plugin-evaluations/src/jev-eval-flow.ts';
import type { PocImportOptions } from './import-poc-flow.ts';

const here = (path: string) => new URL(path, import.meta.url).pathname;

/** The line `hold` says before asking the current question again. Not a POC clip. */
export const HOLD_PREFIX_LINE = 'hold_prefix';

/**
 * Whole replies that ask the agent to wait, or to stop talking and listen: from the 2026-10-07
 * calls ("One minute.", "No, no, one minute.", "Wait, wait one minute.", "stop, listen"), in the
 * normalised form phrases are matched in, with the Hinglish, Hindi and Tamil the POC's lexicons use.
 */
const HOLD_PHRASES = [
  'wait',
  'wait wait',
  'wait please',
  'okay wait',
  'one minute',
  'one minute please',
  'no no one minute',
  'wait one minute',
  'wait wait one minute',
  'wait a minute',
  'just a minute',
  'one second',
  'just a second',
  'hold on',
  'stop listen',
  'stop listen to me',
  'listen to me',
  'please listen',
  'ek minute',
  'ek second',
  'ruko',
  'ruk jao',
  'ek minute ruko',
  'oru nimisham',
  'konjam iru',
  'रुको',
  'एक मिनट',
  'ஒரு நிமிஷம்',
];

/**
 * A lone "what", "sorry" or "kya" is not a request to repeat (P6): on a noisy line it is as often
 * the start of a sentence the turn detector cut short, or a reaction to what was just said. The
 * decision model still hears them and can pick `repeat`.
 */
const NOT_REPEAT = new Set(['what', 'sorry', 'kya', 'sorry what']);

function globalIntent(flow: AgentFlow, key: string): FlowIntent {
  const intent = flow.globalIntents.find((candidate) => candidate.key === key);
  if (!intent) throw new Error(`The CreditMantri flow has no global intent ${key}`);
  return intent;
}

/**
 * What the first live CreditMantri calls (2026-10-07, 4e4d2228 and 8cbac365) changed on top of the
 * POC's map. The POC is vendored unchanged; these are OVO's corrections, applied on every import:
 *
 * - The recording notice and the EMI disclosure are mandatory (P5): call B's caller barged in 0.46 s
 *   into them and the call went on as if they had been heard.
 * - A `hold` global intent (P10): "One minute.", "Wait, wait one minute." went to the LLM or to
 *   `busy`; now the agent says it is no problem and asks its question again, staying put.
 * - `stop_calling` needs explicit do-not-call language and 0.8 confidence (P4, P10): "Ananya,
 *   please stop." (0.60) and "Okay, stop." (0.57) said to an agent talking over the caller were
 *   taken as do-not-call. `abusive`, which also ends the call, needs 0.75: "What is this? You're
 *   so random." scored 0.57 to 0.60 as abusive.
 * - The repeat phrases lose the lone what/sorry/kya (P6).
 *
 * Returns the line ids it adds.
 */
export function adjustCreditMantri(flow: AgentFlow): string[] {
  const disclose = flow.nodes.find((node) => node.id === 'disclose');
  if (!disclose) throw new Error('The CreditMantri flow has no disclose node');
  disclose.mandatory = ['recording', 'emi_status'];

  const repeat = globalIntent(flow, 'repeat');
  repeat.phrases = repeat.phrases.filter((phrase) => !NOT_REPEAT.has(phrase));

  const stop = globalIntent(flow, 'stop_calling');
  stop.description =
    'They explicitly ask CreditMantri never to call them again or to take their number off the ' +
    'list ("stop calling me", "don\'t call this number again"). Not "stop" or "please stop" ' +
    'said to make the agent stop talking or listen to them';
  stop.threshold = 0.8;
  globalIntent(flow, 'abusive').threshold = 0.75;

  flow.lines[HOLD_PREFIX_LINE] = 'Sure, no problem.';
  flow.holdPrefix = HOLD_PREFIX_LINE;
  flow.globalIntents.splice(1, 0, {
    key: 'hold',
    description:
      'They ask the agent to wait a moment, or to stop talking and listen ("one minute", ' +
      '"wait", "hold on", "stop, listen to me"), without asking to end the call',
    phrases: HOLD_PHRASES,
    hold: true,
  });
  return [HOLD_PREFIX_LINE];
}

/**
 * The CreditMantri collections flow: the POC's map (vendored from credit3-collections-poc as of
 * 2026-09-30) imported with the POC's own defaults: agent Ananya and helpline 1800 123 4567 from
 * `lib/config.js`, the decision preamble from `lib/jev.js`, `JEV_MIN_CONFIDENCE` 0.55, then
 * `adjustCreditMantri`. `pnpm flow:import --preset creditmantri` rewrites the fixture; a test fails
 * when it drifts.
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
    adjust: adjustCreditMantri,
  } satisfies PocImportOptions,
};
