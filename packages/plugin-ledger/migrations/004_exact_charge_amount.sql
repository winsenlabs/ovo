-- P11: the exact INR value of each charge before rounding, in paise with up to 12 decimal places.
-- Per-event rounding billed every LLM and decision step (a fraction of a paise each) as 0; a
-- summary now adds the exact values of a call's estimated charges and rounds once. NULL on charges
-- recorded before this migration: summaries fall back to their rounded `amount_paise`.
ALTER TABLE ovo_cost_charges ADD COLUMN exact_amount_paise numeric
  CHECK (exact_amount_paise IS NULL OR exact_amount_paise >= 0);
