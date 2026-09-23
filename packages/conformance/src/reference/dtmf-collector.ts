import type { Clock, TurnConfig } from '@winsendotai/ovo-contracts';

/** Collects DTMF digits into one turn: flushed by the terminator, `maxDigits` or the inter-digit timeout. */
export class DtmfCollector {
  private digits = '';
  private cancel?: () => void;

  constructor(
    private readonly config: TurnConfig['dtmf'],
    private readonly clock: Pick<Clock, 'setTimeout'>,
    private readonly onDigits: (digits: string) => void,
  ) {}

  get collecting(): boolean {
    return this.digits.length > 0;
  }

  push(digit: string): void {
    this.cancel?.();
    if (digit === this.config.terminator) return this.flush();
    this.digits += digit;
    if (this.digits.length >= this.config.maxDigits) return this.flush();
    this.cancel = this.clock.setTimeout(() => this.flush(), this.config.interDigitMs);
  }

  flush(): void {
    this.cancel?.();
    this.cancel = undefined;
    const digits = this.digits;
    this.digits = '';
    if (digits) this.onDigits(digits);
  }

  dispose(): void {
    this.cancel?.();
    this.digits = '';
  }
}
