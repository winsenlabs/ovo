'use client';
import { Field, Notice } from '../primitives';

/** The TCCCPR side of `AgentConfig.compliance` (contracts agent-compliance.ts), structurally. */
export interface ComplianceCategoryBlock {
  category?: 'promotional' | 'service' | 'transactional';
  purpose?: 'rbi_recovery' | 'reminder' | 'onboarding' | 'other';
  disclosures?: {
    identity?: { text: string };
    ai?: { text: string };
    optOutHint?: { text: string };
  };
}

/** The floor each choice brings, as the compliance rule pack (IN-TCCCPR 2026.10.1) applies it. */
export function categoryFloor(block: ComplianceCategoryBlock): string {
  if (block.category === 'promotional')
    return 'Promotional calls go out only from a 140-series number, 10:00–21:00 IST, to numbers with registered consent or a fresh DND scrub.';
  if (block.purpose === 'rbi_recovery')
    return 'Recovery calls stay inside 08:00–19:00 IST (RBI) and need a 1600-series number for RBI-regulated senders.';
  if (block.category)
    return 'Service and transactional calls go out from a 1600 or 1601 number; the default window is 09:00–20:00 IST.';
  return 'Without a category, no +91 number is dialed except the test numbers on the Compliance page.';
}

const LINES = [
  ['identity', 'Identity line', 'This is Asha calling from Example Bank about your loan.'],
  ['ai', 'AI line', 'I am an automated assistant.'],
  ['optOutHint', 'Opt-out hint', 'You can say "stop calling" at any time.'],
] as const;

/**
 * Call category, purpose and the optional opening lines (identity, AI, opt-out hint). Every line
 * is off by default: no rule requires them today (compliance spec Q9).
 */
export function ComplianceCategoryFields({
  block,
  patch,
}: {
  block: ComplianceCategoryBlock;
  patch: (next: ComplianceCategoryBlock) => void;
}) {
  const disclosures = block.disclosures ?? {};
  const setLine = (key: (typeof LINES)[number][0], text: string | undefined) => {
    const next = { ...disclosures, [key]: text === undefined ? undefined : { text } };
    for (const name of Object.keys(next) as (keyof typeof next)[])
      if (next[name] === undefined) delete next[name];
    patch({ disclosures: Object.keys(next).length ? next : undefined });
  };
  return (
    <>
      <div className="form-grid">
        <Field label="Call category" htmlFor="compliance-category">
          <select
            id="compliance-category"
            value={block.category ?? ''}
            onChange={(event) =>
              patch({
                category: (event.target.value || undefined) as ComplianceCategoryBlock['category'],
              })
            }
          >
            <option value="">Not set</option>
            <option value="service">Service (e.g. EMI reminder to a customer)</option>
            <option value="transactional">
              Transactional (within 30 minutes of a transaction)
            </option>
            <option value="promotional">Promotional (any offer or upsell)</option>
          </select>
        </Field>
        <Field label="Purpose" htmlFor="compliance-purpose">
          <select
            id="compliance-purpose"
            value={block.purpose ?? ''}
            onChange={(event) =>
              patch({
                purpose: (event.target.value || undefined) as ComplianceCategoryBlock['purpose'],
              })
            }
          >
            <option value="">Not set</option>
            <option value="rbi_recovery">Loan recovery (RBI-regulated)</option>
            <option value="reminder">Reminder</option>
            <option value="onboarding">Onboarding</option>
            <option value="other">Other</option>
          </select>
        </Field>
      </div>
      <Notice tone={block.category ? 'neutral' : 'warning'}>{categoryFloor(block)}</Notice>
      {LINES.map(([key, label, example]) => (
        <div key={key} className="stack">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={disclosures[key] !== undefined}
              onChange={(event) => setLine(key, event.target.checked ? example : undefined)}
            />
            <span>
              <strong>{label}</strong>
              <small>Spoken before anything else, in the order identity, AI, recording.</small>
            </span>
          </label>
          {disclosures[key] && (
            <Field label={`${label} text`} htmlFor={`compliance-${key}`}>
              <input
                id={`compliance-${key}`}
                maxLength={500}
                value={disclosures[key]!.text}
                onChange={(event) => setLine(key, event.target.value)}
              />
            </Field>
          )}
        </div>
      ))}
    </>
  );
}
