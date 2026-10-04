import { z } from 'zod';
import type { AgentConfig } from './agent.ts';
import { Slot } from './selection.ts';

/** The provider binding as it was when the release was made. Never holds a secret value. */
export const BindingSnapshot = z
  .object({
    provider: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    credentialId: z.string().min(1),
    fingerprint: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type BindingSnapshot = z.infer<typeof BindingSnapshot>;

/** One pinned selection: `id@version`, resolved exact or same-major (§4.2). */
export const ReleaseSelection = z
  .object({
    pluginId: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    bindingId: z.string().min(1).optional(),
    binding: BindingSnapshot.optional(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ReleaseSelection = z.infer<typeof ReleaseSelection>;

export type ReleaseSelectionKey = Slot | `textFilter:${number}` | `companion:${string}`;
export type ReleaseSelections = Partial<Record<ReleaseSelectionKey, ReleaseSelection>>;

const SLOT_KEYS: ReadonlySet<string> = new Set(Slot.options);

/** True for a slot name, `textFilter:<n>` or `companion:<capability key>`. */
export function isReleaseSelectionKey(key: string): key is ReleaseSelectionKey {
  return SLOT_KEYS.has(key) || /^textFilter:(0|[1-9]\d?)$/.test(key) || /^companion:.+$/.test(key);
}

export const ReleaseSelections = z
  .record(z.string(), ReleaseSelection)
  .refine((value) => Object.keys(value).every(isReleaseSelectionKey), {
    message: 'Release selection keys are slots, textFilter:<n> or companion:<key>',
  })
  .transform((value) => value as ReleaseSelections);

export interface Release {
  id: string;
  workspaceId: string;
  agentId: string;
  config: AgentConfig;
  plugins: { id: string; version: string }[];
  /** Absent on releases made before selections existed; those resolve unpinned (§4.2). */
  selections?: ReleaseSelections;
  createdAt: string;
}
