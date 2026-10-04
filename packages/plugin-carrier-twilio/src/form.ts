export type TwilioForm = Record<string, string | readonly string[]>;

/** Twilio REST array fields are repeated form keys, not space-separated values. */
export function encodeTwilioForm(fields: TwilioForm): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') form.append(key, value);
    else for (const item of value) form.append(key, item);
  }
  return form.toString();
}
