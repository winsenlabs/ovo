import { describe, expect, it } from 'vitest';
import {
  createCarrierBindingResolver,
  isPlaceholderCarrierBinding,
  isPlaceholderCredential,
} from '../src/carrier-bindings.ts';

describe('env carrier placeholders', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['   ', true],
    ['not-configured', true],
    ['disabled-local-account', true],
    ['disabled-local-token', true],
    ['replace-with-twilio-token', true],
    ['AC0123456789abcdef', false],
    ['a-real-token', false],
  ])('treats %j as placeholder: %s', (value, expected) => {
    expect(isPlaceholderCredential(value)).toBe(expected);
  });

  it('judges only the credential fields an entry declares', () => {
    expect(isPlaceholderCarrierBinding({ accountSid: '', authToken: '' })).toBe(true);
    expect(
      isPlaceholderCarrierBinding({ accountSid: 'AC1', authToken: 'disabled-local-token' }),
    ).toBe(true);
    expect(
      isPlaceholderCarrierBinding({ accountSid: 'disabled-local-account', authToken: 'x' }),
    ).toBe(true);
    expect(isPlaceholderCarrierBinding({ accountSid: 'AC1', authToken: 'real' })).toBe(false);
    expect(isPlaceholderCarrierBinding({ region: 'IN' })).toBe(false);
  });

  // Bootstrap wrote these two values and Compose rendered them into a binding the resolver accepted.
  it.each([
    { accountSid: 'disabled-local-account', authToken: 'disabled-local-token' },
    { accountSid: 'AC1', authToken: 'disabled-local-token' },
    { accountSid: '', authToken: 'real-token' },
    { accountSid: 'AC1', authToken: 'replace-with-token' },
  ])('refuses to resolve a placeholder env binding %j', async (twilio) => {
    const resolve = createCarrierBindingResolver({
      workspaceId: 'w',
      store: { getProviderBinding: async () => undefined },
      secrets: { resolve: async () => 'unused' },
      registry: {} as never,
      env: { OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ twilio }) },
    });
    await expect(resolve('env', 'twilio')).rejects.toThrow(
      'Environment carrier secret is not configured',
    );
  });
});
