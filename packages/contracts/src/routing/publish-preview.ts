import { z } from 'zod';
import { RouteUuid } from './ids.ts';
import { ROUTING_ISSUE_CODES } from './issue-codes.ts';
import { RoutingChange } from './diff-model.ts';

const Path = z.array(z.union([z.string(), z.number()]));

/** The wire form of `RoutingIssue`. */
export const RoutingIssueView = z.object({
  code: z.enum(ROUTING_ISSUE_CODES),
  severity: z.enum(['error', 'warning']),
  path: Path,
  message: z.string().max(2_000),
});
export type RoutingIssueView = z.infer<typeof RoutingIssueView>;

/**
 * `POST /v1/routing/points/:id/preview-publish`: what publishing the stored draft (or the given
 * one) would do, with nothing written. `digest` is the one publish then stores.
 */
export const PublishPreview = z.object({
  issues: z.array(RoutingIssueView),
  blockers: z.array(RoutingIssueView),
  warnings: z.array(RoutingIssueView),
  canPublish: z.boolean(),
  nextVersion: z.number().int().positive(),
  /** Null while blockers exist (nothing could be pinned). */
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  previous: z
    .object({
      id: RouteUuid,
      version: z.number().int().positive(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  /** The digest equals the previous release's. */
  unchanged: z.boolean(),
  /** Against the latest release (all adds when there is none). */
  changes: z.array(RoutingChange),
  /** Agent references the release would pin: `latest` -> the release id it resolves to now. */
  pins: z.array(
    z.object({
      path: Path,
      agentId: z.string().min(1).max(200),
      was: z.enum(['latest', 'pinned']),
      releaseId: RouteUuid,
    }),
  ),
});
export type PublishPreview = z.infer<typeof PublishPreview>;
