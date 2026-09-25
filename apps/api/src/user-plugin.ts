import { Pool } from 'pg';
import { z } from 'zod';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { UserDirectory } from './user-directory.ts';

export const USER_PLUGIN_ID = '@winsendotai/ovo-api-users';
export const PasswordInput = z.string().min(12).max(128);
export const EmailInput = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
export const SeedAdmin = z.object({
  email: EmailInput,
  password: PasswordInput,
  label: z.string().trim().min(1).max(120).default('Administrator'),
  recoverAfterRestore: z.boolean().default(false),
});
export type SeedAdminInput = z.input<typeof SeedAdmin>;

export function seedAdminFromEnv(env: NodeJS.ProcessEnv = process.env): SeedAdminInput | undefined {
  if (!env.OVO_SEED_ADMIN_EMAIL && !env.OVO_SEED_ADMIN_PASSWORD) return;
  const result = SeedAdmin.safeParse({
    email: env.OVO_SEED_ADMIN_EMAIL,
    password: env.OVO_SEED_ADMIN_PASSWORD,
    label: env.OVO_SEED_ADMIN_LABEL,
    recoverAfterRestore: env.OVO_RESTORE_ADMIN_RECOVERY === 'true',
  });
  if (!result.success)
    throw new Error('Seed administrator requires a valid email and a 12–128 character password');
  return result.data;
}

export function createUserDirectoryPlugin(
  databaseUrl: string,
  organizationId: string,
  input?: SeedAdminInput,
) {
  const seed = input ? SeedAdmin.parse(input) : undefined;
  return definePlugin(
    {
      id: USER_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: ['ovo.users'],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx) => {
      const pool = new Pool({ connectionString: databaseUrl, max: 2 });
      const users = new UserDirectory(pool, organizationId);
      try {
        await users.initialize(
          seed ? { ...seed, role: 'admin' } : undefined,
          seed?.recoverAfterRestore,
        );
      } catch (error) {
        await pool.end();
        throw error;
      }
      ctx.effect(() => () => pool.end());
      ctx.provide('ovo.users', users);
    },
  );
}
