/**
 * OPS-15: what makes a console password unacceptable. Checked at sign-in, where the plaintext is
 * in hand: an account whose password fails is signed in only to change it. Rules, by code:
 *
 * - `too_short`: fewer than 12 characters.
 * - `too_simple`: fewer than three of lowercase, uppercase, digits and symbols, unless it is a
 *   passphrase of 20 characters or more.
 * - `contains_email`: shorter than a passphrase and contains the account email's name part (four
 *   characters or more), which is the first guess against a known address.
 * - `common`: a well-known password, or one character or keyboard run repeated.
 * - `seed_password`: still the bootstrap `OVO_SEED_ADMIN_PASSWORD`, which sits in `.env` and the
 *   container environment, so it must not stay the administrator's password.
 */
export type PasswordIssue =
  'too_short' | 'too_simple' | 'contains_email' | 'common' | 'seed_password';

export const PASSWORD_MIN_LENGTH = 12;
const PASSPHRASE_LENGTH = 20;
const COMMON = [
  'password',
  'passw0rd',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'qwerty',
  'asdfgh',
  'iloveyou',
  'changeme',
  'ovo',
  '123456',
  '654321',
  'abc123',
];

export function passwordIssues(
  password: string,
  context: { email?: string; seedPassword?: string } = {},
): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push('too_short');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (classes < 3 && password.length < PASSPHRASE_LENGTH) issues.push('too_simple');
  const name = context.email?.split('@')[0]?.toLowerCase() ?? '';
  const lowered = password.toLowerCase();
  if (name.length >= 4 && password.length < PASSPHRASE_LENGTH && lowered.includes(name))
    issues.push('contains_email');
  if (isCommon(lowered)) issues.push('common');
  if (context.seedPassword && password === context.seedPassword) issues.push('seed_password');
  return issues;
}

/** A known password with a few digits or symbols around it, or a single repeated unit. */
function isCommon(lowered: string): boolean {
  const core = lowered.replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (COMMON.includes(core) || COMMON.includes(lowered)) return true;
  return /^(.{1,4})\1+$/.test(lowered);
}

export const PASSWORD_ISSUE_TEXT: Record<PasswordIssue, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_simple: `Mix three of lowercase, uppercase, digits and symbols, or use a passphrase of ${PASSPHRASE_LENGTH}+ characters.`,
  contains_email: 'Do not include your email name.',
  common: 'Avoid common passwords and repeated patterns.',
  seed_password: 'Replace the bootstrap password from the server environment.',
};

/** Refuses a new password that fails the policy (422 `weak_password`), naming every rule it breaks. */
export function assertPasswordPolicy(
  password: string,
  context: { email?: string; seedPassword?: string } = {},
): void {
  const issues = passwordIssues(password, context);
  if (issues.length)
    throw Object.assign(new Error(issues.map((code) => PASSWORD_ISSUE_TEXT[code]).join(' ')), {
      statusCode: 422,
      code: 'weak_password',
    });
}
