import { z } from 'zod';

export const Id = z.string().trim().min(1).max(200);
export const DatasetParams = z.object({ datasetId: Id }).strict();
export const ImportBody = z.object({ cases: z.array(z.unknown()).min(1).max(1_000) }).strict();

export const VersionParams = z
  .object({ datasetId: Id, version: z.coerce.number().int().positive() })
  .strict();

export const RunParams = z.object({ runId: Id }).strict();

export const RunBody = z
  .object({
    datasetId: Id,
    datasetVersion: z.number().int().positive(),
    releaseId: Id,
    idempotencyKey: Id,
    maxAttempts: z.number().int().min(1).max(5).default(3),
    executorKind: z.enum(['fixture', 'provider']).default('fixture'),
    providerBindingVersion: Id.optional(),
    budgetAuthorizationId: Id.optional(),
  })
  .strict();

export const CompareBody = z.object({ baselineRunId: Id, candidateRunId: Id }).strict();
