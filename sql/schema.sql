-- Ledger schema. Amounts are NUMERIC(78,0): integers in the asset's smallest unit, wide
-- enough for any uint256. Never store money as float or as a decimal with a scale.

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id            TEXT PRIMARY KEY,                 -- e.g. user:alice:USDT:available
  asset         TEXT NOT NULL,
  balance       NUMERIC(78, 0) NOT NULL DEFAULT 0,
  may_go_negative BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Second line of defence behind the application check.
  CONSTRAINT ledger_accounts_no_overdraft CHECK (may_go_negative OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  ref             TEXT,
  fingerprint     TEXT NOT NULL,                  -- detects key reuse with different content
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_postings (
  id          BIGSERIAL PRIMARY KEY,
  entry_id    BIGINT NOT NULL REFERENCES ledger_entries (id),
  account_id  TEXT NOT NULL REFERENCES ledger_accounts (id),
  asset       TEXT NOT NULL,
  amount      NUMERIC(78, 0) NOT NULL CHECK (amount <> 0)
);

CREATE INDEX IF NOT EXISTS ledger_postings_account_idx ON ledger_postings (account_id);
CREATE INDEX IF NOT EXISTS ledger_postings_entry_idx ON ledger_postings (entry_id);
CREATE INDEX IF NOT EXISTS ledger_entries_ref_idx ON ledger_entries (ref);

-- Postings are append-only: corrections are new entries, never edits.
CREATE OR REPLACE FUNCTION ledger_postings_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_postings is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_postings_no_update ON ledger_postings;
CREATE TRIGGER ledger_postings_no_update
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_postings_append_only();
