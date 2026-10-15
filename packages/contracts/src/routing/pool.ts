import { z } from 'zod';
import { RouteAgentRef, RouteLanguage, RoutingKey } from './ids.ts';
import { RoutingHours } from './hours.ts';

/** One agent a pool can hand a caller to, with what it supports. */
export const PoolMember = z
  .object({
    /** Stable within the pool; capacity is counted per (pool, member). */
    id: RoutingKey,
    /** Resolved to a pinned release at publish. */
    agent: RouteAgentRef,
    languages: z.array(RouteLanguage).min(1).max(12),
    products: z.array(RoutingKey).max(50).default([]),
    skills: z.array(RoutingKey).max(50).default([]),
    /** 0-100, higher is tried first. Equal priority is load-balanced (least active claims). */
    priority: z.number().int().min(0).max(100).default(50),
    hours: RoutingHours.optional(),
    /** Concurrent calls; absent = unlimited (still counted, for balancing). */
    capacity: z.number().int().min(1).max(10_000).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PoolMember = z.infer<typeof PoolMember>;

export const RoutingPoolDefinition = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).optional(),
    members: z.array(PoolMember).min(1).max(100),
    /** Tried in order when no enabled, open member speaks the caller's language. */
    languageFallback: z.array(RouteLanguage).max(5).default([]),
  })
  .strict()
  .refine((pool) => new Set(pool.members.map((member) => member.id)).size === pool.members.length, {
    message: 'Pool member ids must be unique',
    path: ['members'],
  });
export type RoutingPoolDefinition = z.infer<typeof RoutingPoolDefinition>;

export interface RoutingPool {
  id: string;
  workspaceId: string;
  definition: RoutingPoolDefinition;
  version: number;
  createdAt: string;
  updatedAt: string;
}
