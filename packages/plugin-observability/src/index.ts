import { definePlugin } from '@winsendotai/ovo-runtime';
import { priceUsage, summarizeUsage } from './pricing.ts';
import { projectSession } from './projection.ts';
import { redact, evidenceDigest } from './redaction.ts';
export * from './pricing.ts';
export * from './projection.ts';
export * from './redaction.ts';

export const observabilityPlugin = definePlugin(
  {
    id: 'ovo.observability',
    version: '1.0.0',
    contractVersion: 1,
    scope: 'process',
    provides: ['ovo.observability'],
    requires: [],
    configSchema: { type: 'object', additionalProperties: false },
    secretFields: [],
    ui: { label: 'Evidence and cost' },
  },
  (ctx) => {
    ctx.provide('ovo.observability', {
      priceUsage,
      summarizeUsage,
      projectSession,
      redact,
      evidenceDigest,
    });
  },
);
