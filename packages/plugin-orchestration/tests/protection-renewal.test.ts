import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtectionRenewal } from '../src/services.ts';

function fixture() {
  const protection = {
    establish: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
  const fatal = vi.fn(async () => undefined);
  const log = vi.fn();
  const renewal = new ProtectionRenewal(protection, 120_000, fatal, log);
  return { protection, fatal, log, renewal };
}

describe('ProtectionRenewal', () => {
  afterEach(() => vi.useRealTimers());

  it('retries a rejected renewal with backoff while more than five minutes remain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    const subject = fixture();
    subject.protection.renew.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await subject.renewal.establish();
    expect(subject.renewal.protectedUntil().getTime()).toBe(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(subject.protection.renew).toHaveBeenCalledTimes(1);
    expect(subject.fatal).not.toHaveBeenCalled();
    expect(subject.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'protection_renewal_failed' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(subject.protection.renew).toHaveBeenCalledTimes(2);
    expect(subject.renewal.protectedUntil().getTime()).toBe(Date.now() + 3_600_000);
    await subject.renewal.release();
    expect(subject.protection.release).toHaveBeenCalledOnce();
  });

  it('treats transport and deployment blocked failures as retryable until the expiry margin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    const subject = fixture();
    subject.protection.renew.mockRejectedValue(new Error('DEPLOYMENT_BLOCKED'));
    await subject.renewal.establish();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(subject.fatal).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-25T00:56:00.000Z'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(subject.fatal).toHaveBeenCalledOnce();
    expect(subject.protection.renew).toHaveBeenCalledTimes(2);
    await subject.renewal.release();
    expect(subject.protection.release).toHaveBeenCalledOnce();
  });
});
