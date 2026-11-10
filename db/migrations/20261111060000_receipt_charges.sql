-- migrate:up
CREATE TABLE receipt_charges (
  obligation_id bigint NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
  posted_on date NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  source_ref text PRIMARY KEY CHECK (length(source_ref) BETWEEN 1 AND 4000)
);
CREATE INDEX receipt_charges_obligation_id_idx ON receipt_charges(obligation_id);
CREATE TABLE receipt_charge_requests (
  request_id uuid PRIMARY KEY,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object')
);

-- migrate:down
DROP TABLE receipt_charge_requests;
DROP TABLE receipt_charges;
