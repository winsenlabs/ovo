import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { z } from 'zod';
import { requireRole } from '../auth-service.ts';
import { UserDirectory, userError } from '../user-directory.ts';
import { EmailInput, PasswordInput } from '../user-plugin.ts';

const NewUser = z
  .object({
    email: EmailInput,
    password: PasswordInput,
    label: z.string().trim().min(1).max(120),
    role: z.enum(['admin', 'editor']),
  })
  .strict();
const PatchUser = NewUser.omit({ email: true })
  .partial()
  .extend({ disabled: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export function registerUserRoutes(input: {
  app: FastifyInstance;
  users?: UserDirectory;
  store: ControlStore;
  requireTls: boolean;
}) {
  const directory = (request: FastifyRequest, role: 'viewer' | 'admin' = 'admin') => {
    const principal = requireRole(request, role);
    if (!input.users)
      throw userError(503, 'user_management_unavailable', 'User management requires PostgreSQL');
    if (principal.workspaceId !== input.users.organizationId)
      throw userError(403, 'forbidden', 'Organization access denied');
    return { users: input.users, principal };
  };
  const tls = (request: FastifyRequest) => {
    if (input.requireTls && request.protocol !== 'https')
      throw userError(426, 'tls_required', 'Password submission requires TLS');
  };
  input.app.get('/v1/users', async (request) => ({ items: await directory(request).users.list() }));
  input.app.post('/v1/users', async (request, reply) => {
    const { users, principal } = directory(request);
    tls(request);
    const body = NewUser.parse(request.body);
    const user = (await users.create(body))!;
    await input.store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'user.create',
      resourceType: 'user',
      resourceId: user.id,
      payload: { role: user.role },
    });
    return reply.code(201).send(user);
  });
  input.app.patch('/v1/users/:id', async (request) => {
    const { users, principal } = directory(request);
    tls(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patch = PatchUser.parse(request.body);
    const user = await users.update(id, patch);
    await input.store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'user.update',
      resourceType: 'user',
      resourceId: id,
      payload: {
        role: user.role,
        disabled: user.disabled,
        passwordReset: patch.password !== undefined,
      },
    });
    return user;
  });
  input.app.patch('/v1/auth/password', async (request, reply) => {
    const { users, principal } = directory(request, 'viewer');
    tls(request);
    const body = z
      .object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordInput })
      .strict()
      .parse(request.body);
    await users.update(principal.identityId, { password: body.newPassword }, body.currentPassword);
    await input.store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'user.password-change',
      resourceType: 'user',
      resourceId: principal.identityId,
      payload: {},
    });
    return reply
      .header('set-cookie', 'ovo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
      .code(204)
      .send();
  });
}
