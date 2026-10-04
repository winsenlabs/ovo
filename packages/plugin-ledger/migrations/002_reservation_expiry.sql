ALTER TABLE ovo_cost_reservations ADD COLUMN holder text;
ALTER TABLE ovo_cost_reservations ADD COLUMN expires_at timestamptz;
ALTER TABLE ovo_cost_reservations ADD COLUMN session_id text;
ALTER TABLE ovo_cost_reservations ADD COLUMN carrier_provider text;
ALTER TABLE ovo_cost_reservations ADD COLUMN carrier_meter_key text;
ALTER TABLE ovo_cost_reservations ADD COLUMN carrier_price_card_id text;
ALTER TABLE ovo_cost_reservations ADD COLUMN carrier_price_card_version text;
ALTER TABLE ovo_cost_reservations ADD COLUMN carrier_fx_id text;
ALTER TABLE ovo_cost_reservations ADD COLUMN carrier_fx_version text;
CREATE INDEX ovo_cost_reservations_expiry_idx
  ON ovo_cost_reservations (state, expires_at)
  WHERE state = 'reserved';

CREATE TABLE ovo_cost_reservation_events (
  reservation_id text NOT NULL REFERENCES ovo_cost_reservations(id),
  event_type text NOT NULL CHECK (event_type = 'reservation.expired'),
  observed_expiry timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('extended','settled','released')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, event_type, observed_expiry)
);
