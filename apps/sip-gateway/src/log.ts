import { createLogger } from '@winsendotai/ovo-plugin-kit';
import type { Logger } from '@winsendotai/ovo-contracts';

export type { Logger };

export const rootLogger: Logger = createLogger({ service: 'sip-gateway' });

/** Numbers are logged as their last four digits only (§4.7). */
export function last4(number: string | undefined): string | undefined {
  if (!number) return undefined;
  const digits = number.replace(/\D/g, '');
  return digits ? `…${digits.slice(-4)}` : undefined;
}
