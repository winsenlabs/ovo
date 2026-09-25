import type { ConsoleExtension } from './index.js';
const ALL_MODES = ['announcement', 'faq', 'context', 'agent'] as const;

export const coreConsoleExtensions: readonly ConsoleExtension[] = Object.freeze([
  {
    id: 'agent-identity',
    ownerPluginId: '@winsendotai/ovo-console-agent-identity',
    label: 'Agent identity',
    version: '0.1.0',
    forms: [
      {
        id: 'identity',
        title: 'Identity and locale',
        modes: ALL_MODES,
        fields: [
          { path: 'name', label: 'Agent name', kind: 'text' },
          { path: 'language', label: 'Language', kind: 'text', help: 'BCP 47 language tag.' },
          {
            path: 'locale',
            label: 'Locale',
            kind: 'text',
            help: 'Formatting locale for approved values.',
          },
          {
            path: 'timezone',
            label: 'Timezone',
            kind: 'text',
            help: 'IANA timezone used for date rendering.',
          },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'announcement-mode',
    ownerPluginId: '@winsendotai/ovo-console-announcement',
    label: 'Announcement configuration',
    version: '0.1.0',
    forms: [
      {
        id: 'announcement-message',
        title: 'Approved message',
        modes: ['announcement'],
        fields: [
          {
            path: 'message',
            label: 'Message template',
            kind: 'textarea',
            help: 'Variables must be declared in the JSON Schema.',
          },
          { path: 'variables', label: 'Variable JSON Schema', kind: 'json' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'faq-mode',
    ownerPluginId: '@winsendotai/ovo-console-faq',
    label: 'FAQ configuration',
    version: '0.1.0',
    forms: [
      {
        id: 'faq-policy',
        title: 'Deterministic matching policy',
        modes: ['faq'],
        fields: [
          { path: 'faqThreshold', label: 'Minimum match score', kind: 'number', min: 0, max: 1 },
          { path: 'faqMargin', label: 'Required winner margin', kind: 'number', min: 0, max: 1 },
          { path: 'clarification', label: 'Clarification response', kind: 'textarea' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'context-mode',
    ownerPluginId: '@winsendotai/ovo-console-context',
    label: 'Supplied context',
    version: '0.1.0',
    forms: [
      {
        id: 'context-policy',
        title: 'Bounded supplied context',
        modes: ['context', 'agent'],
        fields: [
          { path: 'context', label: 'Approved context', kind: 'textarea' },
          { path: 'contextBudget', label: 'Context budget', kind: 'number', min: 1, max: 100000 },
          { path: 'uncertainty', label: 'Uncertainty response', kind: 'textarea' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'processing-speech',
    ownerPluginId: '@winsendotai/ovo-console-processing-speech',
    label: 'Processing speech',
    version: '0.1.0',
    forms: [
      {
        id: 'processing-speech',
        title: 'Processing phrases',
        modes: ALL_MODES,
        fields: [
          { path: 'processing.initial', label: 'Initial acknowledgment', kind: 'textarea' },
          { path: 'processing.progress', label: 'Delayed progress phrase', kind: 'textarea' },
          {
            path: 'processing.progressAfterMs',
            label: 'Progress delay (ms)',
            kind: 'number',
            min: 1,
          },
          {
            path: 'processing.maxProgress',
            label: 'Maximum progress messages',
            kind: 'number',
            min: 0,
            max: 3,
          },
          { path: 'processing.failure', label: 'Failure wording', kind: 'textarea' },
        ],
      },
    ],
    panels: [],
  },
  {
    id: 'operations-evidence',
    ownerPluginId: '@winsendotai/ovo-console-operations',
    label: 'Operations evidence',
    version: '0.1.0',
    forms: [],
    panels: [
      {
        id: 'recordings',
        title: 'Recordings',
        placement: 'evidence',
        state: 'backend-required',
        description: 'Recording state and alignment require call artifact APIs.',
      },
      {
        id: 'performance',
        title: 'Performance',
        placement: 'evidence',
        state: 'not-implemented',
        description: 'No aggregate cohort or percentile endpoint exists in the management API.',
      },
      {
        id: 'infrastructure',
        title: 'Infrastructure',
        placement: 'evidence',
        state: 'not-implemented',
        description: 'No worker, queue, quota, or capacity endpoint exists in the management API.',
      },
    ],
  },
]);
