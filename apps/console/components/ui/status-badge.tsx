import { humaniseEnum, statusTone, type Tone } from '../../lib/status';

/**
 * The one status badge for new screens, sourced from `lib/status.ts`'s shared tone map (`running`
 * is info, `cancelled` is neutral, `failed` is danger — never green). Pass the raw status value;
 * it is humanised and toned automatically. Use `tone` directly only for a value with no enum
 * (e.g. a literal "Healthy").
 */
export function StatusBadgeV2({
  value,
  tone,
  size = 'md',
  label,
}: {
  value?: string | null;
  tone?: Tone;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const resolvedTone = tone ?? statusTone(value);
  return (
    <span className={`ds-badge tone-${resolvedTone} size-${size}`}>
      <span className="ds-badge-dot" aria-hidden="true" />
      {label ?? humaniseEnum(value)}
    </span>
  );
}
