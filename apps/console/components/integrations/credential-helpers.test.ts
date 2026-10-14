import { describe, expect, it } from 'vitest';
import {
  countByEnvironment,
  countByStatus,
  daysUntilExpiry,
  expiryTone,
  isExpiringSoon,
  usedByCount,
} from './credential-helpers';
import type { CredentialMetadata, ProviderBinding } from '../../lib/api';

const NOW = Date.parse('2026-10-15T00:00:00.000Z');
const cred = (over: Partial<CredentialMetadata>): CredentialMetadata => ({
  id: 'cred_1',
  label: 'Test',
  provider: 'openai',
  type: 'api_key',
  environment: 'production',
  ...over,
});
const binding = (over: Partial<ProviderBinding>): ProviderBinding => ({
  id: 'bnd_1',
  label: 'Binding',
  provider: 'openai',
  environment: 'production',
  credentialId: 'cred_1',
  ...over,
});

describe('daysUntilExpiry / expiryTone', () => {
  it('is null when there is no expiry', () => {
    expect(daysUntilExpiry(undefined, NOW)).toBeNull();
    expect(expiryTone(null, NOW)).toBeUndefined();
  });
  it('is danger once the date has passed', () => {
    const past = new Date(NOW - 2 * 86_400_000).toISOString();
    expect(daysUntilExpiry(past, NOW)).toBeLessThan(0);
    expect(expiryTone(past, NOW)).toBe('danger');
  });
  it('is warn within 14 days, matching the Sarvam fixture (expires in 9 days)', () => {
    const soon = new Date(NOW + 9 * 86_400_000).toISOString();
    expect(expiryTone(soon, NOW)).toBe('warn');
    expect(isExpiringSoon(soon, NOW)).toBe(true);
  });
  it('carries no special tone beyond 14 days out', () => {
    const later = new Date(NOW + 30 * 86_400_000).toISOString();
    expect(expiryTone(later, NOW)).toBeUndefined();
    expect(isExpiringSoon(later, NOW)).toBe(false);
  });
});

describe('countByStatus', () => {
  it('groups credentials by status, defaulting a missing status to unknown', () => {
    const counts = countByStatus([
      cred({ status: 'active' }),
      cred({ status: 'active' }),
      cred({ status: 'retired' }),
      cred({ status: undefined }),
    ]);
    expect(counts.get('active')).toBe(2);
    expect(counts.get('retired')).toBe(1);
    expect(counts.get('unknown')).toBe(1);
  });
});

describe('countByEnvironment', () => {
  it('groups bindings by environment in first-seen order', () => {
    expect(
      countByEnvironment([
        binding({ environment: 'production' }),
        binding({ environment: 'test' }),
        binding({ environment: 'production' }),
      ]),
    ).toEqual([
      { environment: 'production', count: 2 },
      { environment: 'test', count: 1 },
    ]);
  });
});

describe('usedByCount', () => {
  it('counts bindings referencing a credential', () => {
    const bindings = [
      binding({ credentialId: 'cred_1' }),
      binding({ credentialId: 'cred_1' }),
      binding({ credentialId: 'cred_2' }),
    ];
    expect(usedByCount('cred_1', bindings)).toBe(2);
    expect(usedByCount('cred_3', bindings)).toBe(0);
  });
});
