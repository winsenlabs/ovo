const nonEmpty = { type: 'string', minLength: 1, maxLength: 500 } as const;

export const campaignConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'operationId',
    'name',
    'agentReleaseId',
    'fromNumber',
    'schedule',
    'perNumberAttemptLimit',
    'maxAttemptsTotal',
    'maxAttemptsPerLocalDay',
    'activeCallPolicy',
  ],
  properties: {
    operationId: { type: 'string', minLength: 1, maxLength: 200 },
    name: nonEmpty,
    agentReleaseId: nonEmpty,
    fromNumber: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' },
    schedule: {
      type: 'object',
      additionalProperties: false,
      required: ['localDateTime', 'timezone'],
      properties: {
        localDateTime: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$' },
        timezone: nonEmpty,
      },
    },
    perNumberAttemptLimit: { type: 'integer', minimum: 1, maximum: 100 },
    maxAttemptsTotal: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    maxAttemptsPerLocalDay: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    activeCallPolicy: { enum: ['continue', 'request_end'] },
  },
} as const;

export const inboundPolicySchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'reason'],
      properties: { kind: { const: 'busy' }, reason: nonEmpty },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'maxWaitMs', 'announcement'],
      properties: {
        kind: { const: 'wait' },
        maxWaitMs: { type: 'integer', minimum: 1_000, maximum: 300_000 },
        announcement: nonEmpty,
      },
    },
    ...['callback', 'human'].map((kind) => ({
      type: 'object',
      additionalProperties: false,
      required: ['kind', kind === 'callback' ? 'queue' : 'target', 'announcement'],
      properties: {
        kind: { const: kind },
        [kind === 'callback' ? 'queue' : 'target']: nonEmpty,
        announcement: nonEmpty,
      },
    })),
  ],
} as const;

export const handoffPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmationRequired', 'fallback'],
  properties: {
    confirmationRequired: { type: 'boolean' },
    fallback: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'message'],
      properties: {
        kind: { enum: ['resume', 'human', 'end'] },
        target: nonEmpty,
        message: nonEmpty,
      },
    },
  },
} as const;
