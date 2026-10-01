import { z } from 'zod';
import type { AudioFormat } from './audio.ts';

const VariableName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const Placeholders = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g;

/** Definition is immutable at release time; values are supplied per contact before dialing. */
export const TemplatedClip = z
  .object({
    id: z.string().min(1).max(120),
    locale: z.string().min(2).max(35),
    text: z.string().min(1).max(5_000),
    variables: z
      .array(
        z
          .object({
            name: VariableName,
            maxLength: z.number().int().min(1).max(1_000),
            description: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((clip, ctx) => {
    const declared = clip.variables.map((variable) => variable.name);
    const used = [...clip.text.matchAll(Placeholders)].map((match) => match[1]!);
    if (new Set(declared).size !== declared.length)
      ctx.addIssue({ code: 'custom', message: 'Clip variable names must be unique' });
    if (JSON.stringify([...new Set(declared)].sort()) !== JSON.stringify([...new Set(used)].sort()))
      ctx.addIssue({ code: 'custom', message: 'Clip placeholders must match declared variables' });
    if (/\{\{|\}\}/.test(clip.text.replace(Placeholders, '')))
      ctx.addIssue({ code: 'custom', message: 'Clip has an invalid placeholder' });
  });
export type TemplatedClip = z.infer<typeof TemplatedClip>;

export const ClipPreparation = z
  .object({
    workspaceId: z.string().min(1),
    releaseId: z.string().min(1),
    contactId: z.string().min(1),
    clipId: z.string().min(1),
    values: z.record(VariableName, z.string()),
    /** Deadline is relative to dial admission; a timeout must fall back to normal synthesis. */
    deadlineMs: z.number().int().min(1).max(300_000),
  })
  .strict();
export type ClipPreparation = z.infer<typeof ClipPreparation>;

export function validateClipPreparation(clip: TemplatedClip, raw: unknown): ClipPreparation {
  const request = ClipPreparation.parse(raw);
  if (request.clipId !== clip.id) throw new Error('Clip preparation targets another clip');
  const declared = new Map(clip.variables.map((variable) => [variable.name, variable]));
  if (Object.keys(request.values).length !== declared.size)
    throw new Error('Clip preparation must supply every declared variable');
  for (const [name, value] of Object.entries(request.values)) {
    const variable = declared.get(name);
    if (!variable || value.length > variable.maxLength)
      throw new Error(`Clip variable ${name} is unknown or too long`);
  }
  return request;
}

export interface PreparedClip {
  clipId: string;
  contactId: string;
  audio: Uint8Array;
  format: AudioFormat;
  cacheKey: string;
}

export interface TemplatedClipPort {
  prepare(
    clip: TemplatedClip,
    request: ClipPreparation,
    signal: AbortSignal,
  ): Promise<PreparedClip>;
}
