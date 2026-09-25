import type { Clock, TurnConfig } from '@winsendotai/ovo-contracts';

export class DtmfCollector {
  private digits = '';
  private cancelTimer?: () => void;

  constructor(
    private readonly clock: Clock,
    private readonly config: TurnConfig['dtmf'],
    private readonly emit: (digits: string, first: boolean) => void,
  ) {}

  digit(digit: string): void {
    if (digit === this.config.terminator) {
      this.flush();
      return;
    }
    if (!/^[0-9*#ABCD]$/i.test(digit)) return;
    const first = this.digits.length === 0;
    this.digits += digit;
    if (this.digits.length >= this.config.maxDigits) {
      this.flush(first);
      return;
    }
    this.cancelTimer?.();
    this.cancelTimer = this.clock.setTimeout(() => this.flush(), this.config.interDigitMs);
    if (first && this.config.interruptOnFirstDigit) this.emit('', true);
  }

  private flush(first = false): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.digits) return;
    const digits = this.digits;
    this.digits = '';
    this.emit(digits, first);
  }

  dispose(): void {
    this.cancelTimer?.();
    this.digits = '';
  }
}
