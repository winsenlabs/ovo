import { agentCases } from './agent-cases.ts';
import { announcementCases } from './announcement-cases.ts';
import { contextCases } from './context-cases.ts';
import { faqCases } from './faq-cases.ts';

export * from './agent-cases.ts';
export * from './announcement-cases.ts';
export * from './context-cases.ts';
export * from './faq-cases.ts';
export * from './releases.ts';

export const BUILTIN_EVALUATION_CASES = Object.freeze([
  ...announcementCases,
  ...faqCases,
  ...contextCases,
  ...agentCases,
]);
