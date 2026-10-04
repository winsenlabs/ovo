import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { BootstrapIdentity } from './types.ts';
import { hashPassword, verifyPassword } from './user-passwords.ts';

export interface TeamUser {
  id: string;
  email: string;
  label: string;
  role: 'admin' | 'editor';
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface NewTeamUser {
  email: string;
  label: string;
  role: 'admin' | 'editor';
  password: string;
}
export type UserPatch = Partial<Pick<NewTeamUser, 'label' | 'role' | 'password'>> & {
  disabled?: boolean;
};
interface UserRow {
  id: string;
  email: string;
  label: string;
  role: 'admin' | 'editor';
  disabled: boolean;
  restore_quarantined: boolean;
  password_hash: string;
  session_version: number;
  created_at: Date;
  updated_at: Date;
}
const publicUser = (row: UserRow): TeamUser => ({
  id: row.id,
  email: row.email,
  label: row.label,
  role: row.role,
  disabled: row.disabled,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
export const userError = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code });

export class UserDirectory {
  private dummyHash = '';
  constructor(
    readonly pool: Pool,
    readonly organizationId: string,
  ) {}

  async initialize(seed?: NewTeamUser, recoverAfterRestore = false): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ovo_team_users (
      organization_id text NOT NULL, id text NOT NULL, email text NOT NULL,
      label text NOT NULL, role text NOT NULL CHECK (role IN ('admin','editor')),
      password_hash text NOT NULL, disabled boolean NOT NULL DEFAULT false,
      session_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id,id), UNIQUE (organization_id,email)
    )`);
    await this.pool.query(
      'ALTER TABLE ovo_team_users ADD COLUMN IF NOT EXISTS restore_quarantined boolean NOT NULL DEFAULT false',
    );
    this.dummyHash = await hashPassword(randomUUID());
    if (seed) await this.create(seed, true, recoverAfterRestore);
  }

  async list(): Promise<TeamUser[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM ovo_team_users WHERE organization_id=$1 ORDER BY created_at,id LIMIT 500',
      [this.organizationId],
    );
    return result.rows.map(publicUser);
  }

  private identity(row: UserRow): BootstrapIdentity {
    return {
      id: row.id,
      label: row.label,
      token: `database-user:${row.id}:${row.session_version}:${row.password_hash}`,
      defaultWorkspaceId: this.organizationId,
      workspaces: { [this.organizationId]: row.role },
    };
  }

  async authenticate(email: string, password: string): Promise<BootstrapIdentity | undefined> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM ovo_team_users WHERE organization_id=$1 AND email=$2',
      [this.organizationId, email.trim().toLowerCase()],
    );
    const row = result.rows[0];
    const valid = await verifyPassword(password, row?.password_hash ?? this.dummyHash);
    return valid && row && !row.disabled ? this.identity(row) : undefined;
  }

  async resolve(id: string, workspaceId: string): Promise<BootstrapIdentity | undefined> {
    if (workspaceId !== this.organizationId) return;
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM ovo_team_users WHERE organization_id=$1 AND id=$2 AND disabled=false',
      [this.organizationId, id],
    );
    return result.rows[0] ? this.identity(result.rows[0]) : undefined;
  }

  async create(
    input: NewTeamUser,
    seedOnly = false,
    recoverAfterRestore = false,
  ): Promise<TeamUser | undefined> {
    const passwordHash = await hashPassword(input.password);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-users:${this.organizationId}`,
      ]);
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM ovo_team_users WHERE organization_id=$1',
        [this.organizationId],
      );
      if (seedOnly && Number(count.rows[0]!.count) > 0) {
        if (recoverAfterRestore) {
          const rows = await client.query<UserRow>(
            'SELECT * FROM ovo_team_users WHERE organization_id=$1 FOR UPDATE',
            [this.organizationId],
          );
          if (rows.rows.every((row) => row.restore_quarantined)) {
            const admin = rows.rows.find((row) => row.email === input.email.trim().toLowerCase());
            if (!admin || (await verifyPassword(input.password, admin.password_hash)))
              throw userError(
                409,
                'restore_recovery_required',
                'Restore recovery requires an existing user email and a new password',
              );
            await client.query(
              `UPDATE ovo_team_users SET role='admin',disabled=false,password_hash=$3,
              restore_quarantined=false,session_version=session_version+1,updated_at=now()
              WHERE organization_id=$1 AND id=$2`,
              [this.organizationId, admin.id, passwordHash],
            );
          }
        }
        await client.query('COMMIT');
        return;
      }
      if (Number(count.rows[0]!.count) >= 500)
        throw userError(409, 'user_limit', 'Installation user limit reached');
      const result = await client.query<UserRow>(
        `INSERT INTO ovo_team_users(organization_id,id,email,label,role,password_hash)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          this.organizationId,
          randomUUID(),
          input.email.trim().toLowerCase(),
          input.label,
          seedOnly ? 'admin' : input.role,
          passwordHash,
        ],
      );
      await client.query('COMMIT');
      return publicUser(result.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505')
        throw userError(409, 'email_conflict', 'A user with this email already exists');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id: string, patch: UserPatch, currentPassword?: string): Promise<TeamUser> {
    const passwordHash =
      patch.password === undefined ? undefined : await hashPassword(patch.password);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-users:${this.organizationId}`,
      ]);
      const result = await client.query<UserRow>(
        'SELECT * FROM ovo_team_users WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [this.organizationId, id],
      );
      const row = result.rows[0];
      if (!row) throw userError(404, 'user_not_found', 'User not found');
      if (
        currentPassword !== undefined &&
        (row.disabled || !(await verifyPassword(currentPassword, row.password_hash)))
      )
        throw userError(401, 'invalid_credentials', 'Invalid credentials');
      if (row.restore_quarantined && patch.disabled === false && !patch.password)
        throw userError(
          409,
          'restore_recovery_required',
          'Reset this restored user password before enabling the account',
        );
      const role = patch.role ?? row.role,
        disabled = patch.disabled ?? row.disabled;
      if (row.role === 'admin' && !row.disabled && (role !== 'admin' || disabled)) {
        const remaining = await client.query<{ count: string }>(
          `SELECT count(*) FROM ovo_team_users WHERE organization_id=$1 AND role='admin' AND disabled=false AND id<>$2`,
          [this.organizationId, id],
        );
        if (Number(remaining.rows[0]!.count) === 0)
          throw userError(
            409,
            'last_admin',
            'The last active administrator cannot be disabled or demoted',
          );
      }
      const updated = await client.query<UserRow>(
        `UPDATE ovo_team_users SET label=$3,role=$4,disabled=$5,password_hash=$6,
         session_version=session_version+1,restore_quarantined=CASE WHEN $7 THEN false ELSE restore_quarantined END,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [
          this.organizationId,
          id,
          patch.label ?? row.label,
          role,
          disabled,
          passwordHash ?? row.password_hash,
          passwordHash !== undefined,
        ],
      );
      await client.query('COMMIT');
      return publicUser(updated.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
