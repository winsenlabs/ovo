import { describe, expect, it } from 'vitest';
import {
  changePasswordPayload,
  createTeamUserPayload,
  emailPasswordSession,
  legacyTokenSession,
  teamRoleLabel,
  updateTeamUserPayload,
  userManagementErrorMessage,
  userUpdateInvalidatesCurrentSession,
} from '../lib/user-contract';

describe('email and password session contract', () => {
  it('normalizes email and does not add a token field', () => {
    expect(emailPasswordSession('  ADMIN@Example.COM ', 'correct horse battery')).toEqual({
      email: 'admin@example.com',
      password: 'correct horse battery',
    });
  });

  it('keeps legacy token compatibility isolated from the default request', () => {
    expect(legacyTokenSession('fixture-token')).toEqual({ token: 'fixture-token' });
  });
});

describe('flat team request contracts', () => {
  it('creates only Admin or User-backed editor accounts with normalized email', () => {
    expect(
      createTeamUserPayload({
        email: '  USER@Example.com ',
        label: '  Operator ',
        role: 'editor',
        password: 'twelve-characters',
      }),
    ).toEqual({
      email: 'user@example.com',
      label: 'Operator',
      role: 'editor',
      password: 'twelve-characters',
    });
    expect(teamRoleLabel('admin')).toBe('Admin');
    expect(teamRoleLabel('editor')).toBe('User');
  });

  it('omits an unchanged password from an update', () => {
    expect(
      updateTeamUserPayload({ label: ' User ', role: 'editor', disabled: true, password: '' }),
    ).toEqual({ label: 'User', role: 'editor', disabled: true });
    expect(
      updateTeamUserPayload({
        label: 'Admin',
        role: 'admin',
        disabled: false,
        password: 'replacement-password',
      }),
    ).toMatchObject({ password: 'replacement-password' });
  });

  it('uses the own-password endpoint body without account or session selectors', () => {
    expect(changePasswordPayload('current-password', 'replacement-password')).toEqual({
      currentPassword: 'current-password',
      newPassword: 'replacement-password',
    });
  });

  it('requires relogin after an administrator updates their own account', () => {
    expect(userUpdateInvalidatesCurrentSession('user-1', 'user-1')).toBe(true);
    expect(userUpdateInvalidatesCurrentSession('user-2', 'user-1')).toBe(false);
  });

  it('explains protected admin and restore recovery conflicts', () => {
    expect(userManagementErrorMessage('last_admin', undefined, 'fallback')).toContain(
      'last active administrator',
    );
    expect(
      userManagementErrorMessage('restore_recovery_required', undefined, 'fallback'),
    ).toContain('fresh password');
  });
});
