import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@winsendotai/ovo-plugin-storage';
import type { BootstrapIdentity, ManagementApiOptions, Principal } from './types.ts';
interface AuthRequest extends FastifyRequest {
  principal?: Principal;
}
const rank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
const hash = (value: string) => createHash('sha256').update(value).digest();
const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
function cookie(header: string | undefined, name: string) {
  if (!header) return;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
}
export class Authenticator {
  private readonly byId = new Map<string, BootstrapIdentity>();
  constructor(private readonly options: ManagementApiOptions) {
    const tokens = new Set<string>();
    for (const identity of options.identities) {
      const tokenHash = hash(identity.token).toString('hex');
      if (tokens.has(tokenHash)) throw new Error('Operator credentials must be distinct');
      tokens.add(tokenHash);
      if (this.byId.has(identity.id))
        throw new Error(`Duplicate bootstrap identity ${identity.id}`);
      if (!Object.hasOwn(identity.workspaces, identity.defaultWorkspaceId))
        throw new Error(`Default workspace is not authorized for ${identity.id}`);
      this.byId.set(identity.id, identity);
    }
  }
  identityForToken(token: string) {
    const digest = hash(token);
    return this.options.identities.find((identity) => safeEqual(digest, hash(identity.token)));
  }
  createSession(identity: BootstrapIdentity, workspaceId: string) {
    if (!Object.hasOwn(identity.workspaces, workspaceId))
      throw new Error('Workspace is not authorized');
    const payload = Buffer.from(
      JSON.stringify({
        identityId: identity.id,
        tokenVersion: this.tokenVersion(identity),
        workspaceId,
        exp: Math.floor(Date.now() / 1000) + (this.options.sessionTtlSeconds ?? 28_800),
      }),
    ).toString('base64url');
    return `${payload}.${createHmac('sha256', this.options.sessionSecret).update(payload).digest('base64url')}`;
  }
  fromSession(value: string): Principal | undefined {
    try {
      return this.decodeSession(value);
    } catch {
      return undefined;
    }
  }
  private tokenVersion(identity: BootstrapIdentity): string {
    return createHmac('sha256', this.options.sessionSecret)
      .update(identity.token)
      .digest('base64url');
  }
  private decodeSession(value: string): Principal | undefined {
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) return;
    const expected = createHmac('sha256', this.options.sessionSecret).update(payload).digest(),
      supplied = Buffer.from(signature, 'base64url');
    if (!safeEqual(expected, supplied)) return;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      identityId: string;
      workspaceId: string;
      exp: number;
      tokenVersion: string;
    };
    if (!decoded || !Number.isFinite(decoded.exp) || decoded.exp <= Date.now() / 1000) return;
    const identity = this.byId.get(decoded.identityId),
      role =
        identity && Object.hasOwn(identity.workspaces, decoded.workspaceId)
          ? identity.workspaces[decoded.workspaceId]
          : undefined;
    if (!identity || decoded.tokenVersion !== this.tokenVersion(identity)) return;
    return identity && role
      ? { identityId: identity.id, label: identity.label, workspaceId: decoded.workspaceId, role }
      : undefined;
  }
  authenticate(request: FastifyRequest) {
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? this.identityForToken(request.headers.authorization.slice(7))
      : undefined;
    if (bearer)
      return {
        identityId: bearer.id,
        label: bearer.label,
        workspaceId: bearer.defaultWorkspaceId,
        role: bearer.workspaces[bearer.defaultWorkspaceId],
      };
    const session = cookie(request.headers.cookie, 'ovo_session');
    return session ? this.fromSession(session) : undefined;
  }
}
export function requireRole(request: FastifyRequest, role: Role) {
  const principal = (request as AuthRequest).principal;
  if (!principal)
    throw Object.assign(new Error('Authentication required'), {
      statusCode: 401,
      code: 'unauthorized',
    });
  if (!Object.hasOwn(rank, principal.role) || rank[principal.role] < rank[role])
    throw Object.assign(new Error('Insufficient role'), { statusCode: 403, code: 'forbidden' });
  return principal;
}
export const publicIdentity = (principal: Principal) => ({
  id: principal.identityId,
  label: principal.label,
  workspaceId: principal.workspaceId,
  role: principal.role,
});
export const error = (
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) =>
  reply
    .code(status)
    .send({ error: { code, message, ...(details === undefined ? {} : { details }) } });
