import { expect, it } from 'vitest';
import { isPublicAddress } from '../src/index.ts';

it.each([
  '192.88.99.1',
  'fec0::1',
  '::10.0.0.1',
  '2002:0a00:0001::',
  '2001:10::1',
  '2001:20::1',
  '2001:2::1',
  '3fff::1',
])('rejects the kit special-use range %s', (address) =>
  expect(isPublicAddress(address)).toBe(false),
);
