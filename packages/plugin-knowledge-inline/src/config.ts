import { z } from 'zod';
import type { InlineSource } from './chunk.ts';

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);

/**
 * The corpus, carried on the release. The caps are deliberate and visible: a release is snapshotted
 * and shipped, so an unbounded corpus here becomes an unbounded release. 20 sources × 50 documents ×
 * 20,000 characters is the ceiling, and a corpus that outgrows it wants a stored backend behind the
 * same port rather than a larger limit here.
 */
export const InlineSourceConfig = z
  .object({
    id: Id,
    label: z.string().trim().min(1).max(200).optional(),
    documents: z
      .array(
        z
          .object({
            id: Id,
            title: z.string().trim().min(1).max(200).optional(),
            /** Where a human can check this text. Shown with every passage drawn from it. */
            citation: z.string().trim().min(1).max(500).optional(),
            text: z.string().trim().min(1).max(20_000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const InlineKnowledgeRowConfig = z
  .object({ sources: z.array(InlineSourceConfig).min(1).max(20) })
  .strict()
  .refine(
    (config) => new Set(config.sources.map((source) => source.id)).size === config.sources.length,
    'Knowledge source ids must be unique',
  );
export type InlineKnowledgeRowConfig = z.infer<typeof InlineKnowledgeRowConfig>;

export function readRowConfig(row: Record<string, unknown>): { sources: InlineSource[] } {
  return InlineKnowledgeRowConfig.parse(row);
}

/** The JSON Schema the console renders and the host validates the row against. */
export const ROW_CONFIG_SCHEMA = {
  type: 'object',
  required: ['sources'],
  additionalProperties: false,
  properties: {
    sources: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['id', 'documents'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,79}$' },
          label: { type: 'string', minLength: 1, maxLength: 200 },
          documents: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              required: ['id', 'text'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,79}$' },
                title: { type: 'string', minLength: 1, maxLength: 200 },
                citation: { type: 'string', minLength: 1, maxLength: 500 },
                text: { type: 'string', minLength: 1, maxLength: 20000 },
              },
            },
          },
        },
      },
    },
  },
} as const;
