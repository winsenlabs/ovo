export type TeamRole = 'admin' | 'editor';

export interface TeamUser {
  id: string;
  email: string;
  label: string;
  role: TeamRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const USER_PASSWORD_MIN_LENGTH = 12;
export const USER_PASSWORD_MAX_LENGTH = 128;

export function normalizeUserEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function teamRoleLabel(role: TeamRole): 'Admin' | 'User' {
  return role === 'admin' ? 'Admin' : 'User';
}

export function emailPasswordSession(email: string, password: string) {
  return { email: normalizeUserEmail(email), password };
}

export function legacyTokenSession(token: string) {
  return { token };
}

export function createTeamUserPayload(input: {
  email: string;
  label: string;
  role: TeamRole;
  password: string;
}) {
  return {
    email: normalizeUserEmail(input.email),
    label: input.label.trim(),
    role: input.role,
    password: input.password,
  };
}

export function updateTeamUserPayload(input: {
  label: string;
  role: TeamRole;
  disabled: boolean;
  password: string;
}) {
  return {
    label: input.label.trim(),
    role: input.role,
    disabled: input.disabled,
    ...(input.password ? { password: input.password } : {}),
  };
}

export function changePasswordPayload(currentPassword: string, newPassword: string) {
  return { currentPassword, newPassword };
}

export function userUpdateInvalidatesCurrentSession(
  updatedUserId: string,
  currentUserId?: string,
): boolean {
  return currentUserId !== undefined && updatedUserId === currentUserId;
}

export function userManagementErrorMessage(
  code: string | undefined,
  message: string | undefined,
  fallback: string,
): string {
  if (code === 'restore_recovery_required')
    return 'Set a fresh password while enabling this restored user.';
  if (code === 'last_admin')
    return 'The last active administrator cannot be disabled or changed to User.';
  if (code === 'email_conflict') return 'A user with this email already exists.';
  return message ?? fallback;
}
