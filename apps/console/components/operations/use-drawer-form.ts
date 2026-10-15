'use client';
import { useState, type FormEvent } from 'react';

/**
 * Shared "drawer with a create/update form" state: open flag, busy flag, error message, and a
 * `submit` wrapper that does the identical preventDefault → mutate → reset → close → reload →
 * catch → finally dance every create-in-a-drawer form in Costs/Evaluations repeats verbatim
 * (budgets, FX versions, price cards, provider authorizations).
 */
export function useDrawerForm(onSuccess?: () => Promise<void> | void) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(
    event: FormEvent<HTMLFormElement>,
    mutate: (values: FormData) => Promise<void>,
    fallbackMessage = 'Could not be saved.',
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError(undefined);
    try {
      await mutate(values);
      form.reset();
      setOpen(false);
      await onSuccess?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : fallbackMessage);
    } finally {
      setBusy(false);
    }
  }

  return { open, setOpen, busy, error, submit };
}
