import { readFileSync } from 'node:fs';
import type { GoldenConversation } from '../jev-eval-conversation.ts';

/**
 * Golden conversations for the CreditMantri flow (AGT-16), ported from the POC's conversation map
 * and `lib/call.js`, as data (`golden-creditmantri.json`). Every call opens on `greet`; each step
 * is one caller reply (or a silence, `null`), the decision or LLM answer scripted for it when the
 * phrase tier does not resolve it, and what must happen. Variables are the eval corpus's sample
 * call (Rahul Sharma, NACH bounce).
 */
export const CREDITMANTRI_GOLDEN: GoldenConversation[] = JSON.parse(
  readFileSync(new URL('./golden-creditmantri.json', import.meta.url), 'utf8'),
);
