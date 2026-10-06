-- OPS-13: a price card names the model (or SKU) its vendor price applies to, so a release whose
-- binding swaps the model is flagged instead of silently priced at the old model's rate. NULL keeps
-- the card valid for any model (the wildcard every card before this migration had).
-- `provisional` marks a placeholder or unverified price; costs priced with it are labelled so.
ALTER TABLE ovo_cost_price_cards ADD COLUMN model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200);
ALTER TABLE ovo_cost_price_cards ADD COLUMN provisional boolean NOT NULL DEFAULT false;
