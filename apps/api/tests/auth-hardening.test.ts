import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildManagementApi } from '../src/bootstrap.ts';
import { UserDirectory } from '../src/user-directory.ts';
import { assertPasswordPolicy, passwordIssues } from '../src/auth-password-policy.ts';
import { LoginLockout } from '../src/auth-login-limiter.ts';
import { sessionTtlSecondsFromEnv } from '../src/auth-env.ts';

describe('console password policy (OPS-15)', () => {
  it.each([
    ['Tr4in-Kettle-Lamp', []],
    ['correct horse battery staple', []],
    ['short1A!', ['too_short']],
    ['alllowercaseletters', ['too_simple']],
    ['Password1234', ['common']],
    ['!!Welcome2026', ['common']],
    ['abcabcabcabcabc', ['too_simple', 'common']],
    ['Tejas@Ovo2026', ['contains_email']],
  ])('%s -> %j', (password, issues) => {
    expect(passwordIssues(password, { email: 'tejas@example.test' })).toEqual(issues);
  });

  it('refuses a weak new password with every broken rule, as a 422', () => {
    expect(() => assertPasswordPolicy('Tr4in-Kettle-Lamp')).not.toThrow();
    expect(() => assertPasswordPolicy('password')).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'weak_password' }),
    );
    expect(() => assertPasswordPolicy('password')).toThrow(/12 characters.*common passwords/);
  });

  it('flags the bootstrap password from the server environment', () => {
    expect(passwordIssues('Seed-Password-2026', { seedPassword: 'Seed-Password-2026' })).toEqual([
      'seed_password',
    ]);
  });
});

describe('per-account sign-in lockout', () => {
  it('locks after five failures in the window, then reopens; a success clears the count', () => {
    let now = 0;
    const lockout = new LoginLockout({
      maxFailures: 5,
      windowMs: 900_000,
      lockMs: 900_000,
      now: () => now,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) lockout.failed('a');
    expect(lockout.retryAfterSeconds('a')).toBe(0);
    lockout.succeeded('a');
    for (let attempt = 0; attempt < 4; attempt += 1) lockout.failed('a');
    expect(lockout.retryAfterSeconds('a')).toBe(0);
    lockout.failed('a');
    expect(lockout.retryAfterSeconds('a')).toBe(900);
    expect(lockout.retryAfterSeconds('b')).toBe(0);
    now = 899_000;
    expect(lockout.retryAfterSeconds('a')).toBe(1);
    now = 900_000;
    expect(lockout.retryAfterSeconds('a')).toBe(0);
  });

  it('forgets failures older than the window and keeps its memory bounded', () => {
    let now = 0;
    const lockout = new LoginLockout({
      maxFailures: 2,
      windowMs: 1_000,
      lockMs: 1_000,
      maxEntries: 2,
      now: () => now,
    });
    lockout.failed('a');
    now = 2_000;
    lockout.failed('a');
    expect(lockout.retryAfterSeconds('a')).toBe(0);
    lockout.failed('b');
    lockout.failed('c');
    lockout.failed('c');
    expect(lockout.retryAfterSeconds('c')).toBe(1);
  });
});

describe('session lifetime', () => {
  it('reads OVO_SESSION_TTL_SECONDS within 5 minutes and 24 hours', () => {
    expect(sessionTtlSecondsFromEnv({})).toBe(28_800);
    expect(sessionTtlSecondsFromEnv({ OVO_SESSION_TTL_SECONDS: '3600' })).toBe(3_600);
    expect(() => sessionTtlSecondsFromEnv({ OVO_SESSION_TTL_SECONDS: '60' })).toThrow('300');
    expect(() => sessionTtlSecondsFromEnv({ OVO_SESSION_TTL_SECONDS: '1e9' })).toThrow();
  });
});

const url = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!url)('console sign-in hardening through the API', () => {
  const organizationId = `auth-hardening-${randomUUID()}`;
  const strong = 'Tr4in-Kettle-Lamp';
  let pool: Pool;
  let directory: UserDirectory;
  let api: Awaited<ReturnType<typeof buildManagementApi>>;
  const login = async (email: string, password: string) => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/session',
      payload: { email, password },
    });
    return { response, cookie: String(response.headers['set-cookie'] ?? '').split(';')[0]! };
  };
  const get = (path: string, cookie: string) =>
    api.app.inject({ method: 'GET', url: path, headers: { cookie } });

  beforeAll(async () => {
    vi.stubEnv('OVO_SESSION_TTL_SECONDS', '3600');
    pool = new Pool({ connectionString: url, max: 2 });
    api = await buildManagementApi({
      identities: [
        {
          id: 'disabled-bootstrap',
          label: 'Installation',
          token: 'not-an-enabled-bootstrap-token-12345',
          authenticationDisabled: true,
          defaultWorkspaceId: organizationId,
          workspaces: { [organizationId]: 'admin' },
        },
      ],
      sessionSecret: 'synthetic-session-key-at-least-32-characters',
      storageAdapter: 'postgres',
      controlDatabaseUrl: url,
      secretBackend: 'encrypted-store',
      secretsMasterKey: 'ab'.repeat(32),
      requireTlsForSecrets: false,
      secureSessionCookies: true,
      seedAdmin: { email: 'owner@example.test', password: strong },
    });
    directory = new UserDirectory(pool, organizationId);
    await directory.initialize();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM ovo_team_users WHERE organization_id=$1', [organizationId]);
    await directory.create(
      { email: 'owner@example.test', label: 'Owner', role: 'admin', password: strong },
      true,
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await api?.composition.dispose();
    if (pool) {
      await pool.query('DELETE FROM ovo_team_users WHERE organization_id=$1', [organizationId]);
      await pool.end();
    }
  });

  it('issues a Secure session for the configured lifetime to a compliant password', async () => {
    vi.stubEnv('OVO_SESSION_TTL_SECONDS', '3600');
    const { response, cookie } = await login('owner@example.test', strong);
    expect(response.statusCode).toBe(200);
    expect(response.json().passwordChangeRequired).toBeUndefined();
    const header = String(response.headers['set-cookie']);
    expect(header).toContain('HttpOnly; SameSite=Strict; Max-Age=3600; Secure');
    expect((await get('/v1/users', cookie)).statusCode).toBe(200);
  });

  it('confines a weak or bootstrap password to changing it, on a 15-minute session', async () => {
    await directory.create({
      email: 'weak@example.test',
      label: 'Weak',
      role: 'admin',
      password: 'Password1234',
    });
    const weak = await login('weak@example.test', 'Password1234');
    expect(weak.response.statusCode).toBe(200);
    expect(weak.response.json()).toMatchObject({
      passwordChangeRequired: true,
      passwordIssues: [{ code: 'common' }],
    });
    expect(String(weak.response.headers['set-cookie'])).toContain('Max-Age=900');
    const blocked = await get('/v1/users', weak.cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');
    expect((await get('/v1/auth/me', weak.cookie)).json()).toMatchObject({
      passwordChangeRequired: true,
    });
    const changed = await api.app.inject({
      method: 'PATCH',
      url: '/v1/auth/password',
      headers: { cookie: weak.cookie },
      payload: { currentPassword: 'Password1234', newPassword: 'Quiet-Harbour-71' },
    });
    expect(changed.statusCode).toBe(204);
    const renewed = await login('weak@example.test', 'Quiet-Harbour-71');
    expect(renewed.response.json().passwordChangeRequired).toBeUndefined();
    expect((await get('/v1/users', renewed.cookie)).statusCode).toBe(200);

    vi.stubEnv('OVO_SEED_ADMIN_PASSWORD', strong);
    const seeded = await login('owner@example.test', strong);
    expect(seeded.response.json()).toMatchObject({
      passwordChangeRequired: true,
      passwordIssues: [{ code: 'seed_password' }],
    });
  });

  it('locks one account after repeated failures without locking others', async () => {
    await directory.create({
      email: 'other@example.test',
      label: 'Other',
      role: 'editor',
      password: strong,
    });
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await login('owner@example.test', 'Wrong-Guess-0000')).response.statusCode).toBe(401);
    const locked = await login('owner@example.test', strong);
    expect(locked.response.statusCode).toBe(429);
    expect(locked.response.json().error.code).toBe('account_locked');
    expect(Number(locked.response.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('other@example.test', strong)).response.statusCode).toBe(200);
  });
});
