-- migrate:up
CREATE TABLE obligation_merchants (
  merchant text PRIMARY KEY CHECK (merchant = btrim(merchant) AND length(merchant) BETWEEN 1 AND 1000),
  obligation_id bigint NOT NULL REFERENCES obligations(id) ON DELETE CASCADE
);
CREATE INDEX obligation_merchants_obligation_id_idx ON obligation_merchants(obligation_id);
CREATE TABLE obligation_merchant_requests (
  request_id uuid PRIMARY KEY,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object')
);

-- migrate:down
DROP TABLE obligation_merchant_requests;
DROP TABLE obligation_merchants;
