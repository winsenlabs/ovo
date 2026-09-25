export function formatPaise(value?: string | null): string {
  if (value == null) return 'unpriced';
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return `${value} paise`;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(number / 100);
}
export function formatTime(value?: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}
