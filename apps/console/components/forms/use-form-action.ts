'use client';
import { useCallback, type FormEvent } from 'react';

export function useFormAction() {
  return useCallback(
    async (
      event: FormEvent<HTMLFormElement>,
      submit: (values: FormData, form: HTMLFormElement) => Promise<void>,
    ) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      await submit(values, form);
      form.reset();
    },
    [],
  );
}
