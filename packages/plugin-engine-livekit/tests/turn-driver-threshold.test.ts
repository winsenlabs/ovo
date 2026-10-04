import { expect, it, vi } from 'vitest';
import { TurnDriver } from '../src/turn-driver.ts';

it('interrupts only when a non-confirmation transcript reaches minInterruptionWords', () => {
  const cancel = vi.fn();
  const emit = vi.fn();
  const clearBuffer = vi.fn();
  const interrupt = vi.fn();
  const driver = new TurnDriver(
    { behavior: { cancel } } as never,
    {} as never,
    { clearBuffer } as never,
    { emit } as never,
    vi.fn(),
    {} as never,
  );
  Object.assign(driver, {
    active: { segment: {}, handle: { interrupt }, confirmation: false },
  });

  driver.onTranscript('one', 2);
  expect(interrupt).not.toHaveBeenCalled();
  expect(clearBuffer).not.toHaveBeenCalled();
  driver.onTranscript('one two', 2);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(true);
  expect(clearBuffer).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith({ type: 'interrupt', reason: 'transcript' });
});
