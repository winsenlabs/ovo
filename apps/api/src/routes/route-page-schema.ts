import { z } from 'zod';

export const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export const LimitQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
