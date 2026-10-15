import { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

/** Every id in `exampleRoutingSnapshot`, for assertions. */
export const EXAMPLE_IDS = Object.freeze({
  routingPoint: id('a1'),
  routerRelease: id('b0'),
  salesEn: id('b1'),
  salesHi: id('b2'),
  salesTa: id('b3'),
  supportCards: id('c1'),
  supportHi: id('c2'),
  supportLoans: id('c3'),
  salesPool: id('d1'),
  supportPool: id('d2'),
});
const I = EXAMPLE_IDS;

const pinned = (agentId: string, releaseId: string) => ({
  agentId,
  release: { kind: 'pinned' as const, releaseId },
});

const kolkataOffice = {
  timezone: 'Asia/Kolkata',
  weekly: Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, [{ start: '09:00', end: '18:00' }]]),
  ),
};

/**
 * A two-level routing release (§20, shortened): `intent` (keypad 1/2, then an LLM that also detects
 * the language) sends sales to a per-language Sales pool and support on to `product` (keywords,
 * then the LLM), whose card and loan branches reach a Support pool by product. Every agent is
 * pinned; the Tamil sales agent keeps Kolkata office hours. `patch` edits the raw input before it
 * is parsed, so a test can change one field and still get a valid snapshot.
 */
export function exampleRoutingSnapshot(
  patch: (raw: Record<string, any>) => void = () => {},
): RoutingReleaseSnapshot {
  const raw: Record<string, any> = {
    schemaVersion: 1,
    routingPointId: I.routingPoint,
    name: 'Main line',
    router: pinned('front-desk', I.routerRelease),
    defaultTarget: pinned('sales-en', I.salesEn),
    language: { default: 'en', allowed: ['en', 'hi', 'ta'] },
    greeting: {
      en: 'Welcome to Acme. How can I help you today?',
      hi: 'Acme में आपका स्वागत है। मैं आपकी क्या मदद कर सकती हूँ?',
    },
    root: 'intent',
    idle: { timeoutMs: 8000, prompts: [{ en: 'Are you still there?' }] },
    nodes: [
      {
        id: 'intent',
        sets: 'intent',
        ask: { en: 'Is it about buying something new, or an existing account?' },
        engines: [
          {
            kind: 'rules',
            rules: [
              { branch: 'sales', when: [{ kind: 'dtmf', digits: '1' }] },
              { branch: 'support', when: [{ kind: 'dtmf', digits: '2' }] },
            ],
          },
          { kind: 'llm', instructions: 'Decide why the caller is calling.', detectLanguage: true },
        ],
        branches: [
          {
            key: 'sales',
            description: 'Wants to buy something new: prices, plans, new cards or loans',
            target: { kind: 'pool', poolId: I.salesPool, language: 'caller' },
          },
          {
            key: 'support',
            description: 'Has a problem with an existing account, card or loan',
            next: 'product',
          },
        ],
        fallback: [
          { kind: 'reask', times: 1 },
          { kind: 'default' },
          { kind: 'end', line: { en: 'Sorry, I could not connect your call. Goodbye.' } },
        ],
      },
      {
        id: 'product',
        sets: 'product',
        ask: {
          en: 'Is it about a card or a loan?',
          hi: 'कार्ड के बारे में है या लोन के बारे में?',
        },
        engines: [
          {
            kind: 'rules',
            rules: [
              { branch: 'cards', when: [{ kind: 'keywords', words: ['card', 'cards', 'कार्ड'] }] },
              { branch: 'loans', when: [{ kind: 'keywords', words: ['loan', 'loans', 'लोन'] }] },
            ],
          },
          { kind: 'llm', instructions: 'Decide which product the caller needs help with.' },
        ],
        branches: [
          {
            key: 'cards',
            description: 'A credit or debit card',
            target: { kind: 'pool', poolId: I.supportPool, products: { context: 'product' } },
          },
          {
            key: 'loans',
            description: 'A loan',
            target: { kind: 'pool', poolId: I.supportPool, products: { context: 'product' } },
          },
        ],
        fallback: [
          { kind: 'reask', times: 1 },
          { kind: 'default', target: { kind: 'pool', poolId: I.supportPool, language: 'any' } },
          { kind: 'end', line: { en: 'Sorry, I could not connect your call. Goodbye.' } },
        ],
      },
    ],
    pools: {
      [I.salesPool]: {
        id: I.salesPool,
        version: 1,
        name: 'Sales',
        languageFallback: ['en'],
        members: [
          { id: 'sales-en', agent: pinned('sales-en', I.salesEn), languages: ['en'] },
          { id: 'sales-hi', agent: pinned('sales-hi', I.salesHi), languages: ['hi'] },
          {
            id: 'sales-ta',
            agent: pinned('sales-ta', I.salesTa),
            languages: ['ta'],
            hours: kolkataOffice,
          },
        ],
      },
      [I.supportPool]: {
        id: I.supportPool,
        version: 1,
        name: 'Support',
        languageFallback: ['en'],
        members: [
          {
            id: 'support-cards',
            agent: pinned('support-cards', I.supportCards),
            languages: ['en'],
            products: ['cards'],
            priority: 60,
          },
          {
            id: 'support-hi',
            agent: pinned('support-hi', I.supportHi),
            languages: ['hi'],
            products: ['cards', 'loans'],
          },
          {
            id: 'support-loans',
            agent: pinned('support-loans', I.supportLoans),
            languages: ['en'],
            products: ['loans'],
          },
        ],
      },
    },
    releaseIds: [
      I.routerRelease,
      I.salesEn,
      I.salesHi,
      I.salesTa,
      I.supportCards,
      I.supportHi,
      I.supportLoans,
    ],
  };
  patch(raw);
  return RoutingReleaseSnapshot.parse(raw);
}
